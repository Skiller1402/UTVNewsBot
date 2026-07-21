const {
  appendBookingIfAvailable,
  bookingMatchesDate,
  createBookingDraft,
  deleteBookingById,
  getAllDatesInRange,
  hasBookingConflict,
  isActiveBooking,
  normalizeBookingNote,
  normalizeBookingTitle,
} = require('../bookingService');

function booking(overrides = {}) {
  return {
    id: 'existing',
    userId: 1,
    username: 'user',
    date: '21.05.2026',
    startTime: '10:00',
    endTime: '11:00',
    items: ['iphone15'],
    createdAt: '2026-05-21T08:00:00.000Z',
    ...overrides,
  };
}

test('getAllDatesInRange returns every date in the period', () => {
  expect(getAllDatesInRange('21.05.2026', '23.05.2026')).toEqual([
    '21.05.2026',
    '22.05.2026',
    '23.05.2026',
  ]);
});

test('bookingMatchesDate supports multi-day bookings', () => {
  const multiDayBooking = booking({
    date: undefined,
    startDate: '21.05.2026',
    endDate: '23.05.2026',
  });

  expect(bookingMatchesDate(multiDayBooking, '22.05.2026')).toBe(true);
  expect(bookingMatchesDate(multiDayBooking, '24.05.2026')).toBe(false);
});

test('hasBookingConflict checks date, time, and shared equipment', () => {
  const bookings = [booking()];

  expect(hasBookingConflict(bookings, booking({
    id: 'same-item-overlap',
    startTime: '10:30',
    endTime: '11:30',
  }))).toBe(true);

  expect(hasBookingConflict(bookings, booking({
    id: 'different-item-overlap',
    startTime: '10:30',
    endTime: '11:30',
    items: ['djimic'],
  }))).toBe(false);

  expect(hasBookingConflict(bookings, booking({
    id: 'same-item-adjacent',
    startTime: '11:00',
    endTime: '12:00',
  }))).toBe(false);
});

test('hasBookingConflict ignores deleted bookings', () => {
  const bookings = [booking({
    status: 'deleted',
    deletedAt: '2026-05-21T09:00:00.000Z',
    deletedBy: 1,
  })];

  expect(hasBookingConflict(bookings, booking({
    id: 'same-item-overlap',
    startTime: '10:30',
    endTime: '11:30',
  }))).toBe(false);
});

test('appendBookingIfAvailable mutates only when there is no conflict', () => {
  const bookings = [booking()];
  const conflictingBooking = booking({
    id: 'conflict',
    startTime: '10:30',
    endTime: '11:30',
  });

  expect(appendBookingIfAvailable(bookings, conflictingBooking)).toEqual({ conflict: true });
  expect(bookings).toHaveLength(1);

  const availableBooking = booking({
    id: 'available',
    startTime: '11:00',
    endTime: '12:00',
  });

  expect(appendBookingIfAvailable(bookings, availableBooking)).toEqual({
    conflict: false,
    booking: availableBooking,
  });
  expect(bookings).toHaveLength(2);
});

test('createBookingDraft copies items and creates single-day or period bookings', () => {
  const items = ['iphone15'];
  const singleDayBooking = createBookingDraft({
    id: 'new',
    userId: 1,
    username: 'user',
    title: '  Утренний   выпуск  ',
    note: '  Студия   2  ',
    date: '21.05.2026',
    startTime: '10:00',
    endTime: '11:00',
    items,
    createdAt: '2026-05-21T08:00:00.000Z',
  });

  items.push('djimic');

  expect(singleDayBooking).toMatchObject({
    id: 'new',
    date: '21.05.2026',
    status: 'active',
    title: 'Утренний выпуск',
    note: 'Студия 2',
    items: ['iphone15'],
  });
  expect(singleDayBooking.startDate).toBeUndefined();

  const periodBooking = createBookingDraft({
    id: 'period',
    userId: 1,
    username: 'user',
    startDate: '21.05.2026',
    endDate: '22.05.2026',
    startTime: '09:00',
    endTime: '22:00',
    items: ['light'],
    createdAt: '2026-05-21T08:00:00.000Z',
  });

  expect(periodBooking).toMatchObject({
    id: 'period',
    startDate: '21.05.2026',
    endDate: '22.05.2026',
  });
  expect(periodBooking.date).toBeUndefined();
});

test('normalizeBookingTitle trims, collapses spaces, and limits length', () => {
  const longTitle = `  ${'Очень '.repeat(40)}длинное название  `;

  expect(normalizeBookingTitle('  Съемка    интервью  ')).toBe('Съемка интервью');
  expect(normalizeBookingTitle(longTitle)).toHaveLength(120);
  expect(normalizeBookingTitle(null)).toBe('');
});

test('normalizeBookingNote trims, collapses spaces, and limits length', () => {
  const longNote = `  ${'Подробность '.repeat(40)}конец  `;

  expect(normalizeBookingNote('  Павильон    3  ')).toBe('Павильон 3');
  expect(normalizeBookingNote(longNote)).toHaveLength(300);
  expect(normalizeBookingNote(null)).toBe('');
});

test('deleteBookingById marks only own active bookings as deleted', () => {
  const bookings = [
    booking({ id: 'own', userId: 1 }),
    booking({ id: 'other', userId: 2 }),
  ];

  expect(deleteBookingById(bookings, 'other', 1)).toEqual({ deleted: false });
  expect(bookings).toHaveLength(2);

  const result = deleteBookingById(bookings, 'own', 1, { deletedAt: '2026-05-21T09:00:00.000Z' });

  expect(result.deleted).toBe(true);
  expect(result.booking.id).toBe('own');
  expect(result.booking).toMatchObject({
    status: 'deleted',
    deletedAt: '2026-05-21T09:00:00.000Z',
    deletedBy: 1,
  });
  expect(bookings).toHaveLength(2);
  expect(isActiveBooking(result.booking)).toBe(false);
});
