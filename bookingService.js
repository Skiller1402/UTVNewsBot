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
    bookings.some((existing) => isBookingConflict(existing, dateStr, startMin, endMin, booking.items))
  );
}

function createBookingDraft({
  id,
  userId,
  username,
  title,
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

function appendBookingIfAvailable(bookings, booking) {
  if (hasBookingConflict(bookings, booking)) {
    return { conflict: true };
  }

  bookings.push(booking);
  return { conflict: false, booking };
}

function deleteBookingById(bookings, bookingId, userId) {
  const idx = bookings.findIndex((booking) => booking.id === bookingId);

  if (idx === -1 || bookings[idx].userId !== userId) {
    return { deleted: false };
  }

  const booking = bookings[idx];
  bookings.splice(idx, 1);
  return { deleted: true, booking };
}

module.exports = {
  appendBookingIfAvailable,
  bookingMatchesDate,
  createBookingDraft,
  deleteBookingById,
  getAllDatesInRange,
  hasBookingConflict,
  isBookingConflict,
  normalizeBookingTitle,
  parseDateDMY,
};
