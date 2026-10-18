import 'dotenv/config';

const bool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error(`${name} must be true or false`);
  return raw.toLowerCase() === 'true';
};

// Database-only commands must not depend on web-server settings such as PORT.
// Nexus can supply a non-listening PORT value while it runs its database setup step.
export const databaseConfig = Object.freeze({
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: bool('DATABASE_SSL'),
});
