const { timeToMinutes, intervalsOverlap } = require('./timeUtils');

function parseDateDMY(dateStr) {
  const [d, m, y] = dateStr.split('.').map(Number);
  return new Date(y, m - 1, d);
}

function getAllDatesInRange(startDateStr, endDateStr) {
  const start = parseDateDMY(startDateStr);
  const end = parseDateDMY(endDateStr);
  const dates = [];
  const current = new Date(start);

  while (current <= end) {
    const d = String(current.getDate()).padStart(2, '0');
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const y = current.getFullYear();
    dates.push(`${d}.${m}.${y}`);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function bookingMatchesDate(booking, dateStr) {
  if (!isActiveBooking(booking)) {
    return false;
  }

  if (booking.startDate && booking.endDate) {
    return getAllDatesInRange(booking.startDate, booking.endDate).includes(dateStr);
  }
  return booking.date === dateStr;
}

function bookingHasSharedItems(booking, items) {
  if (!Array.isArray(booking.items) || !Array.isArray(items)) {
    return false;
  }
  return booking.items.some((item) => items.includes(item));
}

function isBookingConflict(booking, dateStr, startMin, endMin, items) {
  if (!bookingMatchesDate(booking, dateStr)) {
    return false;
  }
  if (!bookingHasSharedItems(booking, items)) {
    return false;
  }
  return intervalsOverlap(startMin, endMin, timeToMinutes(booking.startTime), timeToMinutes(booking.endTime));
}

function getBookingDates(booking) {
  if (booking.startDate && booking.endDate) {
    return getAllDatesInRange(booking.startDate, booking.endDate);
  }
  return booking.date ? [booking.date] : [];
}

function hasBookingConflict(bookings, booking) {
  const startMin = timeToMinutes(booking.startTime);
  const endMin = timeToMinutes(booking.endTime);
  return getBookingDates(booking).some((dateStr) =>
    bookings.some((existing) => isActiveBooking(existing) && isBookingConflict(existing, dateStr, startMin, endMin, booking.items))
  );
}

function createBookingDraft({
  id,
  userId,
  username,
  title,
  note,
  startTime,
  endTime,
  items,
  date,
  startDate,
  endDate,
  createdAt = new Date().toISOString(),
}) {
  const booking = {
    id,
    userId,
    username,
    title: normalizeBookingTitle(title),
    note: normalizeBookingNote(note),
    status: 'active',
    startTime,
    endTime,
    items: [...items],
    createdAt,
  };

  if (startDate && endDate) {
    booking.startDate = startDate;
    booking.endDate = endDate;
  } else {
    booking.date = date;
  }

  return booking;
}

function normalizeBookingTitle(title) {
  if (typeof title !== 'string') {
    return '';
  }
  return title.trim().replace(/\s+/g, ' ').slice(0, 120);
}

function normalizeBookingNote(note) {
  if (typeof note !== 'string') {
    return '';
  }
  return note.trim().replace(/\s+/g, ' ').slice(0, 300);
}

function getBookingDateLabel(booking) {
  return booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;
}

function getBookingStartDate(booking) {
  return booking.startDate || booking.date;
}

function getBookingStartDateTime(booking) {
  const date = getBookingStartDate(booking);
  if (!date || !booking.startTime) {
    return null;
  }

  const [day, month, year] = date.split('.').map(Number);
  const [hours, minutes] = booking.startTime.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function getDueReminder(booking, now = new Date()) {
  const startDateTime = getBookingStartDateTime(booking);
  if (!startDateTime) {
    return null;
  }

  const msUntilStart = startDateTime.getTime() - now.getTime();
  if (msUntilStart <= 0) {
    return null;
  }

  const reminders = booking.reminders || {};
  if (msUntilStart <= 60 * 60 * 1000) {
    return reminders.hour ? null : { key: 'hour', label: '1 час' };
  }
  if (msUntilStart <= 24 * 60 * 60 * 1000) {
    return reminders.day ? null : { key: 'day', label: '24 часа' };
  }

  return null;
}

function sortBookingsByStart(bookings) {
  return [...bookings].sort((a, b) => {
    const aTime = getBookingStartDateTime(a);
    const bTime = getBookingStartDateTime(b);
    return (aTime ? aTime.getTime() : 0) - (bTime ? bTime.getTime() : 0);
  });
}

function getActiveBookings(bookings) {
  return bookings.filter(isActiveBooking);
}

function isBookingInDateRange(booking, startDate, endDate) {
  return getBookingDates(booking).some((dateStr) => {
    const date = parseDateDMY(dateStr);
    return date >= startDate && date <= endDate;
  });
}

function appendBookingIfAvailable(bookings, booking) {
  if (hasBookingConflict(bookings, booking)) {
    return { conflict: true };
  }

  bookings.push(booking);
  return { conflict: false, booking };
}

function isActiveBooking(booking) {
  return Boolean(booking) && booking.status !== 'deleted' && !booking.deletedAt;
}

function deleteBookingById(bookings, bookingId, userId, options = {}) {
  const { deletedAt = new Date().toISOString() } = options;
  const idx = bookings.findIndex((booking) => booking.id === bookingId);

  if (idx === -1 || bookings[idx].userId !== userId || !isActiveBooking(bookings[idx])) {
    return { deleted: false };
  }

  const booking = bookings[idx];
  booking.status = 'deleted';
  booking.deletedAt = deletedAt;
  booking.deletedBy = userId;
  return { deleted: true, booking };
}

module.exports = {
  appendBookingIfAvailable,
  bookingMatchesDate,
  createBookingDraft,
  deleteBookingById,
  getAllDatesInRange,
  getActiveBookings,
  getBookingDateLabel,
  getDueReminder,
  getBookingStartDateTime,
  hasBookingConflict,
  isActiveBooking,
  isBookingInDateRange,
  isBookingConflict,
  normalizeBookingNote,
  normalizeBookingTitle,
  parseDateDMY,
  sortBookingsByStart,
};
