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

async function list(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  let submissions;
  try {
    submissions = await db
      .from('form_submissions')
      .select('id,form_id,form_name,page_url,created_at,form_index')
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list form submissions:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(submissions) || submissions.length === 0) {
    console.log('No form submissions.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(submissions, null, 2));
    return;
  }

  const rows = submissions.map((s) => [
    s.id.slice(0, 8) + '…',
    s.form_id ? s.form_id.slice(0, 8) + '…' : '-',
    s.form_name || '-',
    s.page_url || '-',
    formatDate(s.created_at),
  ]);
  formatTable(rows, ['ID (short)', 'Form ID', 'Form', 'Page URL', 'Submitted']);
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

  let submissions;
  try {
    submissions = await db
      .from('form_submissions')
      .select('*')
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to export form submissions:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(submissions) || submissions.length === 0) {
    console.log('No form submissions to export.');
    return;
  }

  const format = (options.format || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    console.error('Invalid format. Use "csv" or "json".');
    process.exit(1);
  }

  const defaultName = `submissions.${format}`;
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
        ...submissions.map((s) =>
          [
            s.id,
            s.created_at,
            s.page_url || '',
            s.form_name || '',
            s.form_id || '',
            s.form_index ?? '',
            s.build_id || '',
            JSON.stringify(s.payload || {}),
          ].map(escapeCell).join(','),
        ),
      ];
      fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
    }
  } catch (err) {
    console.error('Failed to write export file:', err.message);
    process.exit(1);
  }

  console.log(`Exported ${submissions.length} submission(s) → ${outFile}`);
}

module.exports = { list, show, exportSubmissions };
