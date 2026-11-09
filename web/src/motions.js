// RobotMotions of the preloaded clips, already computed (physics/motions, `npm run retarget`
// there) and balanced references (training/references, `python -m training.balance`): the robot
// starts moving at once instead of waiting seconds for the retargeting.
const URLS = {
  ...import.meta.glob('../../physics/motions/*.json', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../training/references/*.json', { query: '?url', import: 'default', eager: true }),
};
const urlById = new Map(Object.entries(URLS).map(([path, url]) => [path.split('/').pop().replace(/\.json$/, ''), url]));

/** @returns the RobotMotion of a clip, or null if there is none saved for it */
export async function savedMotion(clipId) {
  const url = urlById.get(clipId) ?? urlById.get(`${clipId}-balanced`);
  if (!url) return null;
  const response = await fetch(url);
  return response.ok ? response.json() : null;
}

/** true if the clip has a saved RobotMotion (it plays at once, with no retargeting). */
export const hasSavedMotion = (clipId) => urlById.has(clipId) || urlById.has(`${clipId}-balanced`);
