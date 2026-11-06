// The factory songs live in src/factory/, which is not in the public repo (.gitignore): they are loaded when the
// folder is there (a local checkout), and without it the list is empty (a first run starts blank, those tests skip)
import type { Song } from './bars';
const mods = import.meta.glob<{ FACTORY: (() => Song)[] }>('./factory/index.ts', { eager: true });
export const FACTORY: (() => Song)[] = Object.values(mods)[0]?.FACTORY ?? [];
