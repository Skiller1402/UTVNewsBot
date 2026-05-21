const fs = require('fs');
const path = require('path');

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

let lock = Promise.resolve();

function withLock(action) {
  const next = lock.then(action, action);
  lock = next.catch(() => {});
  return next;
}

function readBookingsFile() {
  if (!fs.existsSync(BOOKINGS_FILE)) {
    return [];
  }

  const text = fs.readFileSync(BOOKINGS_FILE, 'utf8');
  if (!text.trim()) {
    return [];
  }

  const bookings = JSON.parse(text);
  if (!Array.isArray(bookings)) {
    throw new Error('bookings.json должен содержать массив броней');
  }
  return bookings;
}

function writeBookingsFile(bookings) {
  if (!Array.isArray(bookings)) {
    throw new Error('saveBookings ожидает массив броней');
  }

  const tempFile = `${BOOKINGS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(bookings, null, 2), 'utf8');
  fs.renameSync(tempFile, BOOKINGS_FILE);
}

async function loadBookings() {
  return withLock(readBookingsFile);
}

async function saveBookings(bookings) {
  return withLock(() => writeBookingsFile(bookings));
}

async function updateBookings(updater) {
  return withLock(() => {
    const bookings = readBookingsFile();
    const result = updater(bookings);
    writeBookingsFile(bookings);
    return result;
  });
}

module.exports = {
  loadBookings,
  saveBookings,
  updateBookings
};
