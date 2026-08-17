import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStoryboard,
  getStoryboard,
  listStoryboards,
  updateStoryboard,
  deleteStoryboard,
  addShotToStoryboard,
  updateShot,
  deleteShot,
  reorderShots,
} from '../dist-server/forge-storyboard.js';

test('StoryboardSequence CRUD operations persist sequences and metadata', () => {
  const seq = createStoryboard({
    title: 'Cyberpunk Chase Scene',
    description: 'A 3-shot sequence featuring Captain Marcus racing through Neo-Tokyo',
    defaultFps: 24,
    videoModel: 'ltx-video',
  });

  assert.ok(seq.id.startsWith('sb_'));
  assert.equal(seq.title, 'Cyberpunk Chase Scene');
  assert.equal(seq.defaultFps, 24);

  const fetched = getStoryboard(seq.id);
  assert.ok(fetched);
  assert.equal(fetched.title, 'Cyberpunk Chase Scene');

  const updated = updateStoryboard(seq.id, { description: 'Updated chase description' });
  assert.equal(updated.description, 'Updated chase description');

  const list = listStoryboards();
  assert.ok(list.some((s) => s.id === seq.id));

  const deleted = deleteStoryboard(seq.id);
  assert.equal(deleted, true);
  assert.equal(getStoryboard(seq.id), null);
});

test('addShotToStoryboard adds and increments shot orderIndex properly', () => {
  const seq = createStoryboard({
    title: 'Test Sequence',
  });

  const shot1 = addShotToStoryboard(seq.id, {
    title: 'Establishing View',
    shotType: 'establishing',
    cameraMovement: 'pan_right',
    prompt: 'Wide aerial view of the neon skyline at midnight',
    durationSeconds: 4,
    fps: 24,
  });

  assert.equal(shot1.orderIndex, 1);
  assert.equal(shot1.shotType, 'establishing');
  assert.equal(shot1.status, 'draft');

  const shot2 = addShotToStoryboard(seq.id, {
    title: 'Hero Close-Up',
    shotType: 'close_up',
    cameraMovement: 'zoom_in',
    prompt: 'Tight shot on Marcus looking up into the rain',
  });

  assert.equal(shot2.orderIndex, 2);
  assert.equal(shot2.shotType, 'close_up');

  const fetched = getStoryboard(seq.id);
  assert.equal(fetched.shots.length, 2);
  assert.equal(fetched.shots[0].id, shot1.id);
  assert.equal(fetched.shots[1].id, shot2.id);

  // Update shot
  const updatedShot = updateShot(seq.id, shot1.id, { title: 'Wide City Establishing' });
  assert.equal(updatedShot.title, 'Wide City Establishing');

  // Reorder shots
  const reordered = reorderShots(seq.id, [shot2.id, shot1.id]);
  assert.equal(reordered.shots[0].id, shot2.id);
  assert.equal(reordered.shots[0].orderIndex, 1);
  assert.equal(reordered.shots[1].id, shot1.id);
  assert.equal(reordered.shots[1].orderIndex, 2);

  // Delete shot
  const shotDeleted = deleteShot(seq.id, shot2.id);
  assert.equal(shotDeleted, true);
  const afterDelete = getStoryboard(seq.id);
  assert.equal(afterDelete.shots.length, 1);
  assert.equal(afterDelete.shots[0].orderIndex, 1);

  // Cleanup
  deleteStoryboard(seq.id);
});
