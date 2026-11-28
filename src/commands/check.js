'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const { getProjectConfig } = require('../auth');
const { readPageFilesWithMap, listAssetsFromDir } = require('../parser');
const {
  formatDiagnostic,
  summarize,
  mapDiagnostics,
  countDiagnostics,
  isTruncated,
  clean,
  MAX_DIAGNOSTICS,
} = require('../diagnostics');
const { planFixes, applyFixesToRaw, renderUnifiedDiff } = require('../fixes');
const { checkContent: defaultCheckContent } = require('../check-api');

// Exit codes: 0 clean, 1 problems found, 2 could not check.
const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_FAILED = 2;

// Mirrors what /check accepts; push uploads every asset, but a name past
// these limits can't be a project file anyway.
const MAX_LOCAL_FILES = 1000;
const MAX_LOCAL_FILE_NAME = 255;

const NOT_A_TTY =
  'micropage fix asks about each fix and needs a terminal. Use --yes to apply every fix, ' +
  'or `micropage check --diff > fixes.patch`.';

const HELP = [
  'y - apply this fix',
  'n - skip this fix',
  'a - apply this fix and every remaining fix',
  'q - stop here; apply only the fixes already accepted',
  '? - show this help',
];

function makeIo(deps = {}) {
  return {
    out: deps.stdout || ((s) => process.stdout.write(`${s}\n`)),
    err: deps.stderr || ((s) => process.stderr.write(`${s}\n`)),
    write: deps.write || ((s) => process.stdout.write(s)),
    checkContent: deps.checkContent || defaultCheckContent,
    getToken: deps.getToken,
    refresh: deps.refresh,
  };
}

function exitCodeFor(diagnostics, strict) {
  const c = countDiagnostics(diagnostics);
  if (c.error > 0) return EXIT_PROBLEMS;
  if (strict && c.warning > 0) return EXIT_PROBLEMS;
  return EXIT_OK;
}

function localFilesFor(dir) {
  return listAssetsFromDir(dir)
    .filter((name) => name.length <= MAX_LOCAL_FILE_NAME)
    .slice(0, MAX_LOCAL_FILES);
}

/**
 * Load the project folder and its merged .page text. Returns
 * `{ dir, config, map }`, or `{ error }` with the message to print.
 */
function loadProject(dirArg) {
  const dir = path.resolve(dirArg || process.cwd());
  const config = getProjectConfig(dir);
  if (!config?.projectId) {
    return { error: 'Not in a project folder. Run from a folder with .micropage/project.json' };
  }
  let map;
  try {
    map = readPageFilesWithMap(dir, { keepRaw: true });
  } catch (err) {
    return { error: err.message };
  }
  if (!map.text.trim()) return { error: 'No content found in .page files.' };
  return { dir, config, map };
}

async function runCheck(io, project) {
  const { diagnostics } = await io.checkContent({
    text: project.map.text,
    projectId: project.config.projectId,
    localFiles: localFilesFor(project.dir),
    getToken: io.getToken,
    refresh: io.refresh,
  });
  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function printReport(log, diagnostics, map) {
  if (diagnostics.length === 0) {
    log('No problems found.');
    return;
  }
  for (const d of diagnostics) log(formatDiagnostic(d, map));
  const summary = summarize(diagnostics, 'Check');
  if (summary) log(summary);
}

function skipNote(s) {
  const where = s.file ? `${clean(s.file)}:${s.line}` : 'micropage';
  return `${where}: note: fix not applied: ${s.reason}.`;
}

// ---------------------------------------------------------------------------
// micropage check
// ---------------------------------------------------------------------------

/** Returns the exit code; never writes files or creates builds. */
async function check(dirArg, options = {}, deps = {}) {
  const io = makeIo(deps);
  if (options.json && options.diff) {
    io.err('--json and --diff cannot be used together.');
    return EXIT_FAILED;
  }

  const project = loadProject(dirArg);
  if (project.error) {
    io.err(project.error);
    return EXIT_FAILED;
  }

  let diagnostics;
  try {
    diagnostics = await runCheck(io, project);
  } catch (err) {
    io.err(`Check failed: ${err.message}`);
    return EXIT_FAILED;
  }
  const code = exitCodeFor(diagnostics, !!options.strict);

  if (options.json) {
    io.out(JSON.stringify({
      diagnostics: mapDiagnostics(diagnostics, project.map),
      counts: countDiagnostics(diagnostics),
      truncated: isTruncated(diagnostics),
    }, null, 2));
    return code;
  }

  if (options.diff) {
    printReport(io.err, diagnostics, project.map);
    const { fixes, skipped } = planFixes(project.map, project.map.text, diagnostics);
    for (const s of skipped) io.err(skipNote(s));
    const patch = renderUnifiedDiff(fixes, project.map, {
      context: 3,
      onSkip: (name) => io.err(`${clean(name)}: note: left out of the diff; its name can't appear in a patch.`),
    });
    if (patch) io.write(patch);
    else io.err('No fixes to suggest.');
    return code;
  }

  printReport(io.out, diagnostics, project.map);
  return code;
}

// ---------------------------------------------------------------------------
// micropage fix
// ---------------------------------------------------------------------------

/**
 * Line-based prompt over stdin. `ask` resolves to the next typed line, or
 * null on end of input or Ctrl-C. Lines typed or pasted ahead of a question
 * are queued for the following questions rather than lost.
 */
function createTerminalPrompt({ input = process.stdin, output = process.stdout, terminal = true } = {}) {
  const rl = readline.createInterface({ input, output, terminal });
  let closed = false;
  let pending = null;
  const queued = [];
  rl.on('line', (line) => {
    if (pending) {
      const p = pending;
      pending = null;
      p(line);
    } else {
      queued.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    const p = pending;
    pending = null;
    if (p) p(null);
  });
  rl.on('SIGINT', () => {
    output.write('\n');
    // Ctrl-C aborts even with answers queued.
    queued.length = 0;
    rl.close();
  });
  return {
    ask(question) {
      rl.setPrompt(question);
      if (queued.length) {
        output.write(`${question}${queued[0]}\n`);
        return Promise.resolve(queued.shift());
      }
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending = resolve;
        rl.prompt();
      });
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

function describeFix(fix, index, total, map) {
  const header = formatDiagnostic(fix.diagnostic, map).split('\n')[0];
  const lines = [`Fix ${index} of ${total}: ${header}`];
  const d = fix.diagnostic;
  if (d.line !== fix.mergedLine) lines.push(`  at: ${clean(fix.file)}:${fix.line}`);
  lines.push(`  old: ${clean(fix.oldText)}`, `  new: ${clean(fix.newText)}`);
  return lines;
}

/**
 * Replace `file` with `text` via a synced temp file in the same directory and
 * a rename, keeping mode and (where allowed) owner. The rename gives the path
 * a new inode, so other hard links to the file keep the old content.
 */
function writeAtomic(file, text) {
  const target = fs.realpathSync(file);
  const st = fs.statSync(target);
  const mode = st.mode & 0o7777;
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fchmodSync(fd, mode);
    try {
      fs.fchownSync(fd, st.uid, st.gid);
    } catch {
      // Only root can give a file away; keeping our own ownership is fine.
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* never created or already renamed */ }
    throw err;
  }
}

function isWritable(file) {
  try {
    fs.accessSync(fs.realpathSync(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write accepted fixes file by file. A file that is not UTF-8, is read-only,
 * or changed in any way since the check is left alone entirely. Returns
 * `{ written, failed }` counts of files.
 */
function writeFixes(io, project, accepted) {
  let written = 0;
  let failed = 0;
  // With a listener installed, Node hands Ctrl-C to the event loop instead of
  // killing the process, and this loop is synchronous, so a signal can't land
  // between a temp file's write and its rename; it stops the command after.
  const onSigint = () => {
    io.err('Stopped after writing fixes; not checking again.');
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    for (const f of project.map.files) {
      const fileFixes = accepted.filter((x) => x.file === f.name);
      if (fileFixes.length === 0) continue;
      const file = path.join(project.dir, f.name);
      const name = clean(f.name);
      if (f.utf8 === false) {
        io.out(`${name} is not UTF-8; nothing written to it.`);
        continue;
      }
      let current;
      try {
        current = fs.readFileSync(file);
      } catch {
        current = null;
      }
      const unchanged = current != null && Buffer.isBuffer(f.bytes) && current.equals(f.bytes);
      const next = unchanged ? applyFixesToRaw(f.raw, fileFixes) : null;
      if (next == null) {
        io.out(`${name} changed since the check; nothing written to it.`);
        continue;
      }
      if (!isWritable(file)) {
        io.out(`${name} is read-only; nothing written to it.`);
        continue;
      }
      try {
        writeAtomic(file, next);
      } catch (err) {
        io.err(`Could not write ${name}: ${clean(err.message)}`);
        failed++;
        continue;
      }
      written++;
      io.out(`Wrote ${fileFixes.length} fix${fileFixes.length === 1 ? '' : 'es'} to ${name}.`);
    }
  } finally {
    setImmediate(() => process.removeListener('SIGINT', onSigint));
  }
  return { written, failed };
}

/** Returns the exit code. */
async function fix(dirArg, options = {}, deps = {}) {
  const io = makeIo(deps);
  const isTTY = deps.isTTY !== undefined ? deps.isTTY : !!process.stdin.isTTY;
  if (!options.yes && !isTTY) {
    io.err(NOT_A_TTY);
    return EXIT_FAILED;
  }

  const project = loadProject(dirArg);
  if (project.error) {
    io.err(project.error);
    return EXIT_FAILED;
  }

  let diagnostics;
  try {
    diagnostics = await runCheck(io, project);
  } catch (err) {
    io.err(`Check failed: ${err.message}`);
    return EXIT_FAILED;
  }

  printReport(io.out, diagnostics, project.map);
  const { fixes, skipped } = planFixes(project.map, project.map.text, diagnostics);
  for (const s of skipped) io.out(skipNote(s));
  if (fixes.length === 0) {
    io.out('No fixes to apply.');
    return exitCodeFor(diagnostics, false);
  }

  const accepted = [];
  let applyAll = !!options.yes;
  const prompt = applyAll ? null : deps.prompt || createTerminalPrompt();
  try {
    for (let i = 0; i < fixes.length; i++) {
      const block = describeFix(fixes[i], i + 1, fixes.length, project.map);
      if (applyAll) {
        for (const l of block) io.out(l);
        io.out('Applying.');
        accepted.push(fixes[i]);
        continue;
      }
      for (const l of block) io.out(l);
      let answer;
      for (;;) {
        const reply = await prompt.ask('Apply this fix? [y,n,a,q,?] ');
        if (reply == null) {
          io.out('Stopped. Nothing was written.');
          return EXIT_FAILED;
        }
        answer = reply.trim().toLowerCase();
        if (['y', 'n', 'a', 'q'].includes(answer)) break;
        if (answer === '?') for (const l of HELP) io.out(l);
      }
      if (answer === 'q') break;
      if (answer === 'n') continue;
      accepted.push(fixes[i]);
      if (answer === 'a') applyAll = true;
    }
  } finally {
    if (prompt && typeof prompt.close === 'function') prompt.close();
  }

  if (accepted.length === 0) {
    io.out('No fixes accepted. Nothing was written.');
    return exitCodeFor(diagnostics, false);
  }

  const { written, failed } = writeFixes(io, project, accepted);
  if (written === 0) return failed > 0 ? EXIT_FAILED : exitCodeFor(diagnostics, false);

  io.out('Checking again.');
  const again = loadProject(project.dir);
  if (again.error) {
    io.err(`Fixes were written, but the second check could not run: ${again.error}`);
    return EXIT_FAILED;
  }
  let remaining;
  try {
    remaining = await runCheck(io, again);
  } catch (err) {
    io.err(`Fixes were written, but the second check failed: ${err.message}`);
    return EXIT_FAILED;
  }
  printReport(io.out, remaining, again.map);
  if (failed > 0) return EXIT_FAILED;
  return exitCodeFor(remaining, false);
}

module.exports = { check, fix, createTerminalPrompt, NOT_A_TTY };
