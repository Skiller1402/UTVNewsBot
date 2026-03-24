const { timeToMinutes, minutesToTime, intervalsOverlap } = require('../timeUtils');

test('timeToMinutes and minutesToTime round trip', () => {
  expect(timeToMinutes('09:30')).toBe(570);
  expect(minutesToTime(570)).toBe('09:30');
  expect(minutesToTime(0)).toBe('00:00');
  expect(timeToMinutes('23:59')).toBe(23 * 60 + 59);
});

test('intervalsOverlap detects overlaps correctly', () => {
  expect(intervalsOverlap(540, 600, 570, 630)).toBe(true); // 09:00-10:00 with 09:30-10:30
  expect(intervalsOverlap(540, 600, 600, 660)).toBe(false); // adjacent no overlap
  expect(intervalsOverlap(600, 660, 540, 600)).toBe(false); // adjacent no overlap reversed
  expect(intervalsOverlap(600, 660, 630, 690)).toBe(true); // 10:00-11:00 with 10:30-11:30
});
