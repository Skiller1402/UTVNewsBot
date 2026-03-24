const fs = require('fs');
const path = require('path');

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

let lock = Promise.resolve();

function withLock(action) {
  const next = lock.then(action, action);
  lock = next.catch(() => {});
  return next;
}

async function loadBookings() {
  return withLock(() => {
    try {
      if (fs.existsSync(BOOKINGS_FILE)) {
        const text = fs.readFileSync(BOOKINGS_FILE, 'utf8');
        if (!text.trim()) return [];
        return JSON.parse(text);
      }
    } catch (e) {
      console.error('Ошибка чтения bookings.json:', e);
    }
    return [];
  });
}

async function saveBookings(bookings) {
  return withLock(() => {
    try {
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2), 'utf8');
    } catch (e) {
      console.error('Ошибка записи bookings.json:', e);
    }
  });
}

module.exports = {
  loadBookings,
  saveBookings
};
