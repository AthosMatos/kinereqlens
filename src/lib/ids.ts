let counter = 0;

/** Short unique id (unique within this JS realm; random suffix makes cross-realm collisions negligible). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.floor(Math.random() * 0x100000000).toString(36);
  return `${prefix}${counter.toString(36)}${rand}`;
}
