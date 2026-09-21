import { glob } from 'tinyglobby';

export async function discover(
  root: string,
  include: string[],
  exclude: string[],
): Promise<string[]> {
  const found = await glob(include, { cwd: root, ignore: exclude, absolute: false, dot: false });
  return found.sort();
}
