'use strict';

/**
 * Central configuration constants for the CLI.
 * All values can be overridden with environment variables for local development.
 */
const SUPABASE_URL =
  process.env.MICROPAGE_SUPABASE_URL || 'https://vhlifcdslnmnvnvorluu.supabase.co';

// This is the public anon key – safe to embed in the CLI (same as the web app).
const SUPABASE_ANON_KEY =
  process.env.MICROPAGE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZobGlmY2RzbG5tbnZudm9ybHV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjUxMTUzMTMsImV4cCI6MjA0MDY5MTMxM30.IprHOpa397Wcv5iFwa_e9hkXhhmXYZFXC4BF_qGYkkk';

const APP_URL = process.env.MICROPAGE_APP_URL || 'https://app.micropage.sh';

const BUILD_COMPILER_URL =
  process.env.MICROPAGE_BUILD_COMPILER_URL ||
  process.env.MICROPAGE_PARSER_URL ||
  'https://build-compiler.micropage.sh';

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, APP_URL, BUILD_COMPILER_URL };
