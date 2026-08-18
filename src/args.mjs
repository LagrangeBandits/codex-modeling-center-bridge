export function parseArgs(argv) {
  const values = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      values[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
    } else {
      values[raw] = true;
    }
  }

  return { values, positionals };
}

export function valueOf(parsed, name, fallback = undefined) {
  const value = parsed.values[name];
  return value === undefined ? fallback : value;
}

export function hasFlag(parsed, name) {
  return parsed.values[name] === true || parsed.values[name] === "true";
}

export function requiredValue(parsed, name) {
  const value = valueOf(parsed, name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少 --${name}`);
  }
  return value.trim();
}
