'use strict';

const fs = require('fs');
const path = require('path');

const { db, handleAuthError } = require('../supabase');
const { getProjectConfig } = require('../auth');
const { formatTable, formatDate } = require('../utils');

function formatCliFieldValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Spam is `flagged_at IS NOT NULL`; the inbox is everything else. */
function applySpamFilter(query, spam) {
  return spam ? query.not('flagged_at', 'is', 'null') : query.is('flagged_at', 'null');
}

async function list(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  const spam = Boolean(options.spam);
  const columns = spam
    ? 'id,form_id,form_name,page_url,created_at,form_index,spam_reason,flagged_at,flagged_by'
    : 'id,form_id,form_name,page_url,created_at,form_index';

  let submissions;
  try {
    submissions = await applySpamFilter(
      db.from('form_submissions').select(columns).eq('project_id', config.projectId),
      spam,
    )
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list form submissions:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(submissions) || submissions.length === 0) {
    console.log(spam ? 'No spam submissions.' : 'No form submissions.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(submissions, null, 2));
    return;
  }

  const rows = submissions.map((s) => {
    const row = [
      s.id.slice(0, 8) + '…',
      s.form_id ? s.form_id.slice(0, 8) + '…' : '-',
      s.form_name || '-',
      s.page_url || '-',
      formatDate(s.created_at),
    ];
    if (spam) row.push(s.spam_reason || '-');
    return row;
  });
  const headers = ['ID (short)', 'Form ID', 'Form', 'Page URL', 'Submitted'];
  if (spam) headers.push('Spam reason');
  formatTable(rows, headers);
}

async function show(id, options = {}) {
  if (!id) {
    console.error('Usage: micropage submissions show <submission-id>');
    process.exit(1);
  }

  let submission;
  try {
    submission = await db
      .from('form_submissions')
      .select('*')
      .eq('id', id)
      .single();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch submission:', err.message);
    process.exit(1);
  }

  if (!submission) {
    console.error('Submission not found:', id);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(submission, null, 2));
    return;
  }

  console.log('ID:         ', submission.id);
  if (submission.flagged_at) {
    console.log('Spam:       ', submission.spam_reason || 'yes');
  }
  console.log('Form ID:    ', submission.form_id || '-');
  console.log('Form:       ', submission.form_name || '-');
  console.log('Page URL:   ', submission.page_url || '-');
  console.log('Form index: ', submission.form_index ?? '-');
  console.log('Submitted:  ', formatDate(submission.created_at));
  console.log('Build ID:   ', submission.build_id || '-');
  const fields = submission.payload?.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    console.log('');
    console.log('Fields:');
    for (const row of fields) {
      console.log(`  ${row.label}: ${formatCliFieldValue(row.value)}`);
    }
  }
  console.log('');
  console.log('Payload:');
  console.log(JSON.stringify(submission.payload || {}, null, 2));
}

async function exportSubmissions(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  const spam = Boolean(options.spam);

  let submissions;
  try {
    submissions = await applySpamFilter(
      db.from('form_submissions').select('*').eq('project_id', config.projectId),
      spam,
    )
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to export form submissions:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(submissions) || submissions.length === 0) {
    console.log(spam ? 'No spam submissions to export.' : 'No form submissions to export.');
    return;
  }

  const format = (options.format || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    console.error('Invalid format. Use "csv" or "json".');
    process.exit(1);
  }

  const defaultName = spam ? `submissions-spam.${format}` : `submissions.${format}`;
  const outFile = options.output
    ? path.isAbsolute(options.output)
      ? options.output
      : path.join(cwd, options.output)
    : path.join(cwd, defaultName);

  try {
    if (format === 'json') {
      fs.writeFileSync(outFile, JSON.stringify(submissions, null, 2), 'utf8');
    } else {
      const header = [
        'id',
        'created_at',
        'page_url',
        'form_name',
        'form_id',
        'form_index',
        'build_id',
        'payload_json',
      ];
      if (spam) header.push('spam_reason');
      const escapeCell = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes('"') || str.includes(',') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      const lines = [
        header.join(','),
        ...submissions.map((s) => {
          const cells = [
            s.id,
            s.created_at,
            s.page_url || '',
            s.form_name || '',
            s.form_id || '',
            s.form_index ?? '',
            s.build_id || '',
            JSON.stringify(s.payload || {}),
          ];
          if (spam) cells.push(s.spam_reason || '');
          return cells.map(escapeCell).join(',');
        }),
      ];
      fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
    }
  } catch (err) {
    console.error('Failed to write export file:', err.message);
    process.exit(1);
  }

  const noun = spam ? 'spam submission(s)' : 'submission(s)';
  console.log(`Exported ${submissions.length} ${noun} → ${outFile}`);
}

module.exports = { list, show, exportSubmissions, applySpamFilter };
