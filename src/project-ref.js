'use strict';

/** Match standard UUID strings (accepts any version nibble). */
const PROJECT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProjectUuid(s) {
  return typeof s === 'string' && PROJECT_UUID_RE.test(s.trim());
}

function isLegacyNumericProjectId(s) {
  return typeof s === 'string' && /^\d+$/.test(String(s).trim());
}

/**
 * Load a project row from a CLI argument: UUID, legacy numeric id, or domain.
 */
async function fetchProjectByUserRef(db, ref) {
  const r = String(ref).trim();
  if (!r) return null;
  if (isProjectUuid(r)) {
    return db.from('projects').select('*').eq('uuid', r).single();
  }
  if (isLegacyNumericProjectId(r)) {
    return db.from('projects').select('*').eq('id', r).single();
  }
  return db.from('projects').select('*').eq('domain', r).single();
}

/**
 * Load project from `.micropage/project.json` fields (prefers uuid when set).
 */
async function fetchProjectFromConfig(db, config) {
  if (!config) return null;
  if (config.projectUuid) {
    const row = await db
      .from('projects')
      .select('*')
      .eq('uuid', String(config.projectUuid).trim())
      .single();
    if (row) return row;
  }
  if (config.projectId != null) {
    return db.from('projects').select('*').eq('id', config.projectId).single();
  }
  return null;
}

module.exports = {
  isProjectUuid,
  isLegacyNumericProjectId,
  fetchProjectByUserRef,
  fetchProjectFromConfig,
};
