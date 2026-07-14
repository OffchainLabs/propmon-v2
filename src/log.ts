type Fields = Record<string, unknown>;

const LEVELS = ["debug", "info", "warn"] as const;
type Level = (typeof LEVELS)[number];

const envLevel = process.env.LOG_LEVEL as Level | undefined;
const minLevel = envLevel && LEVELS.includes(envLevel) ? LEVELS.indexOf(envLevel) : LEVELS.indexOf("info");

function write(level: Level, msg: string, fields?: Fields) {
  if (LEVELS.indexOf(level) < minLevel) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  console.log(line);
}

export const debug = (msg: string, fields?: Fields) => write("debug", msg, fields);
export const info = (msg: string, fields?: Fields) => write("info", msg, fields);
export const warn = (msg: string, fields?: Fields) => write("warn", msg, fields);
