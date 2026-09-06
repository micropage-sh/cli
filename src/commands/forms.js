'use strict';

const { db, handleAuthError } = require('../supabase');
const { getProjectConfig } = require('../auth');
const { formatTable, formatDate } = require('../utils');

const FORM_COLUMNS = 'id,form_name,page_url,is_footer,created_at';

/** Occurrence number among same-named forms on the same page, 1-based. */
function formLabel(form) {
  const ordinal = Number(form.form_ordinal) || 0;
  return ordinal > 0 ? `${form.form_name} (${ordinal + 1})` : form.form_name;
}

function fetchForms(projectId, withOrdinal) {
  const q = db
    .from('forms')
    .select(withOrdinal ? `${FORM_COLUMNS},form_ordinal` : FORM_COLUMNS)
    .eq('project_id', projectId);

  return withOrdinal
    ? q.order('page_url,form_ordinal', 'asc').get()
    : q.order('created_at', 'asc').get();
}

async function list(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  let forms;
  try {
    forms = await fetchForms(config.projectId, true);
  } catch (err) {
    handleAuthError(err);
    // form_ordinal is newer than some deployed databases; selecting a column
    // that does not exist fails the whole request, so retry the older shape.
    try {
      forms = await fetchForms(config.projectId, false);
    } catch (retryErr) {
      handleAuthError(retryErr);
      console.error('Failed to list forms:', retryErr.message);
      process.exit(1);
    }
  }

  if (!Array.isArray(forms) || forms.length === 0) {
    console.log('No forms found for this project.');
    return;
  }

  // Count submissions per form_id
  let submissions;
  try {
    submissions = await db
      .from('form_submissions')
      .select('form_id')
      .eq('project_id', config.projectId)
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch submission counts:', err.message);
    process.exit(1);
  }

  const counts = {};
  if (Array.isArray(submissions)) {
    for (const s of submissions) {
      if (s.form_id) counts[s.form_id] = (counts[s.form_id] || 0) + 1;
    }
  }

  if (options.json) {
    const out = forms.map((f) => ({
      ...f,
      form_ordinal: Number(f.form_ordinal) || 0,
      submission_count: counts[f.id] || 0,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const rows = forms.map((f) => [
    formLabel(f),
    f.page_url,
    f.is_footer ? 'footer' : 'inline',
    String(counts[f.id] || 0),
    formatDate(f.created_at),
  ]);
  formatTable(rows, ['Form', 'Page URL', 'Type', 'Submissions', 'Created']);
}

module.exports = { list };
