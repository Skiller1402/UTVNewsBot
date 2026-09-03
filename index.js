const path = require('path');
const fs = require('fs');

require('dotenv').config({
  path: path.join(process.cwd(), '.env'),
});

const TelegramBot = require('node-telegram-bot-api');
const Calendar = require('telegram-inline-calendar');
const calendarLang = require('telegram-inline-calendar/src/language.json');

let uuidv4;
try {
  const uuid = require('uuid');
  uuidv4 = uuid.v4 || (uuid.default && uuid.default.v4);
} catch (err) {
  console.warn('[uuid] модуль не найден, будет использован crypto.randomUUID();', err.message);
}
if (!uuidv4) {
  try {
    const { randomUUID } = require('crypto');
    uuidv4 = () => randomUUID();
  } catch (err) {
    throw new Error('Невозможно инициализировать uuid. Установите uuid@8 или обновите Node.js (>=14.17).');
  }
}

const { loadBookings, updateBookings } = require('./storage');
const { timeToMinutes } = require('./timeUtils');
const {
  appendBookingIfAvailable,
  bookingMatchesDate,
  createBookingDraft,
  deleteBookingById,
  getActiveBookings,
  getBookingDateLabel,
  getDueReminder,
  isActiveBooking,
  isBookingInDateRange,
  isBookingConflict,
  normalizeBookingNote,
  normalizeBookingTitle,
  parseDateDMY,
  sortBookingsByStart,
} = require('./bookingService');
const {
  afterDeleteKeyboard,
  bookingConfirmKeyboard,
  bookingPeriodKeyboard,
  deleteConfirmKeyboard,
  endTimeKeyboard,
  equipmentKeyboard,
  mainMenuAndBookKeyboard,
  mainMenuKeyboard,
  mainMenuOnlyKeyboard,
  myBookingsKeyboard,
  myBookingsReturnKeyboard,
  noteKeyboard,
  timeKeyboard,
  titleKeyboard,
} = require('./keyboards');

//

const { createBooking } = require('./createBooking');

//

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN не установлен. Создайте .env с BOT_TOKEN=...');
  process.exit(1);
}

const TELEGRAM_PROXY_URL = process.env.TELEGRAM_SOCKS_PROXY_URL || process.env.SOCKS_PROXY_URL || process.env.ALL_PROXY;

let bot;
let calendar;

function maskProxyUrl(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    if (url.username) {
      url.username = '***';
    }
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch (error) {
    return '<invalid proxy url>';
  }
}

async function createBotOptions() {
  const options = {
    polling: true,
    request: {
      timeout: 30000,
    },
  };

  if (TELEGRAM_PROXY_URL) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    options.request.agent = new SocksProxyAgent(TELEGRAM_PROXY_URL);
    console.log(`[telegram] SOCKS proxy enabled: ${maskProxyUrl(TELEGRAM_PROXY_URL)}`);
  }

  return options;
}

function logTelegramMethodError(methodName, error) {
  console.error(`[telegram] ${methodName} failed:`, error && (error.stack || error.message || error));
}

function sendMessage(...args) {
  return bot.sendMessage(...args).catch((error) => {
    logTelegramMethodError('sendMessage', error);
    return null;
  });
}

async function sendLongMessage(chatId, text, options = {}) {
  const chunks = text.match(/[\s\S]{1,3500}/g) || [''];

  for (const [index, chunk] of chunks.entries()) {
    await sendMessage(chatId, chunk, index === chunks.length - 1 ? options : {});
  }
}

function editMessageText(...args) {
  return bot.editMessageText(...args).catch((error) => {
    logTelegramMethodError('editMessageText', error);
    return null;
  });
}



function patchCalendarErrorHandling(calendarInstance) {
  calendarInstance.sendMessageCalendar = function sendMessageCalendar(menu, msg) {
    const langKey = this.checkLanguage(msg.chat.id);
    const text = this.options.time_selector_mod === true ? calendarLang.selectdatetime[langKey] : calendarLang.select[langKey];
    return this.bot.sendMessage(msg.chat.id, text, menu)
      .then((sentMessage) => this.chats.set(sentMessage.chat.id, sentMessage.message_id))
      .catch((error) => logTelegramMethodError('calendar.sendMessageCalendar', error));
  };

  calendarInstance.sendMessageTime = function sendMessageTime(menu, msg) {
    return this.bot.sendMessage(msg.chat.id, calendarLang.selecttime[this.checkLanguage(msg.chat.id)], menu)
      .then((sentMessage) => this.chats.set(sentMessage.chat.id, sentMessage.message_id))
      .catch((error) => logTelegramMethodError('calendar.sendMessageTime', error));
  };

  calendarInstance.sendMessageLanguageSelect = function sendMessageLanguageSelect(menu, msg) {
    return this.bot.sendMessage(msg.chat.id, calendarLang.selectlang[this.options.language], menu)
      .then((sentMessage) => this.chats.set(sentMessage.chat.id, sentMessage.message_id))
      .catch((error) => logTelegramMethodError('calendar.sendMessageLanguageSelect', error));
  };

  calendarInstance.editMessageReplyMarkupCalendar = function editMessageReplyMarkupCalendar(date, query) {
    return this.bot.editMessageReplyMarkup(
      this.createNavigationKeyboard(this.checkLanguage(query.message.chat.id), date),
      { message_id: query.message.message_id, chat_id: query.message.chat.id }
    ).catch((error) => logTelegramMethodError('calendar.editMessageReplyMarkupCalendar', error));
  };

  calendarInstance.editMessageReplyMarkupTime = function editMessageReplyMarkupTime(date, query, fromCalendar) {
    return this.bot.editMessageReplyMarkup(
      this.createTimeSelector(this.checkLanguage(query.message.chat.id), date, fromCalendar),
      { message_id: query.message.message_id, chat_id: query.message.chat.id }
    ).catch((error) => logTelegramMethodError('calendar.editMessageReplyMarkupTime', error));
  };
}

const MIN_DURATION_MINUTES = 30;
const TIME_GRID_COLUMNS = 5;
const TIME_START_HOUR = 9;
const TIME_END_HOUR = 22;
const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getNextHalfHourMinutes() {
  const now = new Date();
  const minutes = now.getMinutes();
  if (minutes <= 30) {
    return now.getHours() * 60 + 30;
  }
  return (now.getHours() + 1) * 60;
}

function getBookingTitle(booking) {
  return normalizeBookingTitle(booking && booking.title);
}

function formatBookingTitleLine(booking) {
  const title = getBookingTitle(booking);
  return title ? `   Съемка: ${title}\n` : '';
}

function formatBookingTitleBlockFromState(state) {
  const title = normalizeBookingTitle(state && state.title);
  return title ? `Съемка: ${title}\n` : '';
}

function formatBookingNoteLine(booking) {
  const note = normalizeBookingNote(booking && booking.note);
  return note ? `   Комментарий: ${note}\n` : '';
}

function formatBookingNoteBlockFromState(state) {
  const note = normalizeBookingNote(state && state.note);
  return note ? `Комментарий: ${note}\n` : '';
}

function formatBookingLine(booking, index) {
  const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
  const dateStr = getBookingDateLabel(booking);
  return `${index + 1}. ${dateStr} ${booking.startTime}–${booking.endTime}\n${formatBookingTitleLine(booking)}${formatBookingNoteLine(booking)}   ${itemsNames}`;
}

function formatBookingSummaryFromState(state) {
  const itemsNames = state.cart.map((id) => products[id] || id).join(', ');
  const dateDisplay = state.startDate && state.endDate ? `${state.startDate} — ${state.endDate}` : state.selectedDate;
  return [
    'Проверьте бронь:',
    '',
    `${formatBookingTitleBlockFromState(state)}${formatBookingNoteBlockFromState(state)}Оборудование: ${itemsNames}`,
    `Когда: ${dateDisplay} ${state.startTime} – ${state.endTime}`,
  ].join('\n');
}

function isDateInPast(dateStr) {
  const date = parseDateDMY(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function buildBookingDraftFromState(state, userId, username) {
  return createBookingDraft({
    id: uuidv4(),
    userId,
    username,
    title: state.title,
    note: state.note,
    startTime: state.startTime,
    endTime: state.endTime,
    items: state.cart,
    startDate: state.startDate,
    endDate: state.endDate,
    date: state.selectedDate,
  });
}

function startNoteEntry(chatId, state) {
  state.mode = 'booking_enter_note';
  sendMessage(chatId, 'Добавьте комментарий к брони (место, ответственный, детали) или нажмите «Пропустить».', {
    reply_markup: noteKeyboard(),
  });
}



async function savePendingBooking(chatId, userId, username, state) {
  if (!state.pendingBooking) {
    sendMessage(chatId, 'Нет брони для подтверждения. Начните заново.', {
      reply_markup: mainMenuAndBookKeyboard(),
    });
    return;
  }

  const bookingResult = await updateBookings((bookings) => appendBookingIfAvailable(bookings, state.pendingBooking));

  if (bookingResult.conflict) {
    sendMessage(chatId, '❌ Конфликт: выбранные позиции уже зарезервированы на это время.', {
      reply_markup: mainMenuAndBookKeyboard(),
    });
    return;
  }

  const booking = bookingResult.booking;
  const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
  const dateDisplay = getBookingDateLabel(booking);
  sendMessage(chatId, `✅ Успешно забронировано!\n\n${formatBookingTitleLine(booking)}${formatBookingNoteLine(booking)}Оборудование: ${itemsNames}\nКогда: ${dateDisplay} ${booking.startTime} – ${booking.endTime}`, {
    reply_markup: mainMenuOnlyKeyboard(),
  });


  delete userStates[chatId];
}

function startDateSelection(chatId, message, state) {
  state.mode = 'booking_select_start_date';
  sendMessage(chatId, 'Выберите **начало** периода бронирования:', {
    parse_mode: 'Markdown',
  });
  calendar.startNavCalendar(message);
}

const userStates = {};

const products = {
  iphone15: 'iPhone 15 Pro Max',
  iphone16: 'iPhone 16 Pro Max',
  iphone17pro: 'iPhone 17 Pro Max',
  djimic: 'DJI Mic 2',
  djimicmini: 'DJI Mic Mini',
  light: 'Накамерный свет',
  iphoneTripod: 'Штатив для iPhone',
};

function showMainMenu(chatId) {
  sendMessage(chatId, 'Выберите действие:', {
    reply_markup: mainMenuKeyboard(),
  });
}

function resetStateAndShowMainMenu(chatId) {
  delete userStates[chatId];
  showMainMenu(chatId);
}

function startAllBookingsDateView(chatId, message) {
  userStates[chatId] = { mode: 'view_date' };
  sendMessage(chatId, 'Выберите дату для просмотра всех броней:', {
    reply_markup: mainMenuOnlyKeyboard(),
  });
  calendar.startNavCalendar(message);
}

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException:', error);
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[process] ${signal} received, stopping bot polling...`);

  if (!bot) {
    process.exit(0);
  }

  try {
    await bot.stopPolling();
    console.log('[process] bot polling stopped');
    process.exit(0);
  } catch (error) {
    console.error('[process] failed to stop bot polling:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function notifyCallbackFailure(query, error) {
  const chatId = query && query.message && query.message.chat && query.message.chat.id;
  console.error('[telegram] callback_query failed:', {
    data: query && query.data,
    chatId,
    error: error && (error.stack || error.message || error),
  });

  if (query && query.id) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Произошла ошибка. Попробуйте еще раз.',
        show_alert: false,
      });
    } catch (answerError) {
      console.warn('[telegram] answerCallbackQuery failed after error:', answerError.message);
    }
  }

  if (chatId) {
    try {
      await sendMessage(chatId, 'Произошла внутренняя ошибка. Попробуйте еще раз или вернитесь в меню.', {
        reply_markup: mainMenuOnlyKeyboard(),
      });
    } catch (sendError) {
      console.warn('[telegram] failed to send error message:', sendError.message);
    }
  }
}

function formatBookingsList(title, bookings) {
  if (bookings.length === 0) {
    return `${title}\n\nНет записей.`;
  }

  return [
    title,
    '',
    bookings.map((booking, index) => formatBookingLine(booking, index)).join('\n\n'),
  ].join('\n');
}
async function handleWeekCommand(msg) {
  const chatId = msg.chat.id;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 6);

  const bookings = sortBookingsByStart(getActiveBookings(await loadBookings())
    .filter((booking) => booking.userId === msg.from.id)
    .filter((booking) => isBookingInDateRange(booking, today, end)));

  await sendLongMessage(chatId, formatBookingsList('Ваши активные брони на ближайшие 7 дней:', bookings), {
    reply_markup: mainMenuOnlyKeyboard(),
  });
}

async function handleSearchCommand(msg, match) {
  const chatId = msg.chat.id;
  const query = (match[1] || '').trim().toLowerCase();
  if (!query) {
    sendMessage(chatId, 'Использование: /search текст', {
      reply_markup: mainMenuOnlyKeyboard(),
    });
    return;
  }

  const sourceBookings = getActiveBookings(await loadBookings())
    .filter((booking) => booking.userId === msg.from.id);
  const bookings = sortBookingsByStart(sourceBookings.filter((booking) => {
    const haystack = [
      booking.title,
      booking.note,
      booking.username,
      String(booking.userId),
      booking.items.map((id) => products[id] || id).join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }));

  await sendLongMessage(chatId, formatBookingsList(`Результаты поиска: ${query}`, bookings), {
    reply_markup: mainMenuOnlyKeyboard(),
  });
}

async function handleFreeCommand(msg, match) {
  const chatId = msg.chat.id;
  const [, dateStr, startTime, endTime] = match;
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  if (Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin) {
    sendMessage(chatId, 'Использование: /free 21.06.2026 10:00 12:00', {
      reply_markup: mainMenuOnlyKeyboard(),
    });
    return;
  }

  const bookings = getActiveBookings(await loadBookings());
  const busy = new Set();
  Object.keys(products).forEach((productId) => {
    if (bookings.some((booking) => isBookingConflict(booking, dateStr, startMin, endMin, [productId]))) {
      busy.add(productId);
    }
  });

  const freeItems = Object.entries(products)
    .filter(([id]) => !busy.has(id))
    .map(([, name]) => `• ${name}`);
  const busyItems = Object.entries(products)
    .filter(([id]) => busy.has(id))
    .map(([, name]) => `• ${name}`);

  sendMessage(chatId, [
    `Техника на ${dateStr} ${startTime}–${endTime}:`,
    '',
    'Свободно:',
    freeItems.length ? freeItems.join('\n') : 'нет',
    '',
    'Занято:',
    busyItems.length ? busyItems.join('\n') : 'нет',
  ].join('\n'), {
    reply_markup: mainMenuAndBookKeyboard(),
  });
}

function handleCancelCommand(msg) {
  delete userStates[msg.chat.id];
  sendMessage(msg.chat.id, 'Текущий сценарий сброшен.', {
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleEditTitleCommand(msg, match) {
  const chatId = msg.chat.id;
  const bookingId = match[1];
  const title = normalizeBookingTitle(match[2]);

  const result = await updateBookings((bookings) => {
    const booking = bookings.find((item) => item.id === bookingId && isActiveBooking(item));
    if (!booking || booking.userId !== msg.from.id) {
      return { updated: false };
    }
    booking.title = title;
    booking.updatedAt = new Date().toISOString();
    booking.updatedBy = msg.from.id;
    return { updated: true, booking };
  });

  sendMessage(chatId, result.updated ? 'Название съемки обновлено.' : 'Бронь не найдена или недоступна.', {
    reply_markup: myBookingsReturnKeyboard(),
  });
}

async function handleEditNoteCommand(msg, match) {
  const chatId = msg.chat.id;
  const bookingId = match[1];
  const note = normalizeBookingNote(match[2]);

  const result = await updateBookings((bookings) => {
    const booking = bookings.find((item) => item.id === bookingId && isActiveBooking(item));
    if (!booking || booking.userId !== msg.from.id) {
      return { updated: false };
    }
    booking.note = note;
    booking.updatedAt = new Date().toISOString();
    booking.updatedBy = msg.from.id;
    return { updated: true, booking };
  });

  sendMessage(chatId, result.updated ? 'Комментарий обновлен.' : 'Бронь не найдена или недоступна.', {
    reply_markup: myBookingsReturnKeyboard(),
  });
}

async function checkBookingReminders() {
  const now = new Date();
  const dueReminders = await updateBookings((bookings) => {
    const due = [];

    bookings.filter(isActiveBooking).forEach((booking) => {
      const reminder = getDueReminder(booking, now);
      if (!reminder) {
        return;
      }

      booking.reminders = booking.reminders || {};
      booking.reminders[reminder.key] = new Date().toISOString();
      due.push({ booking: { ...booking, items: [...booking.items] }, label: reminder.label });
    });

    return due;
  });

  await Promise.all(dueReminders.map(({ booking, label }) => {
    const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
    return sendMessage(booking.userId, [
      `Напоминание: до съемки осталось ${label}`,
      `${getBookingDateLabel(booking)} ${booking.startTime}–${booking.endTime}`,
      `${formatBookingTitleLine(booking)}${formatBookingNoteLine(booking)}${itemsNames}`,
    ].join('\n'), {
      reply_markup: myBookingsReturnKeyboard(),
    });
  }));
}

function startReminderLoop() {
  setInterval(() => {
    checkBookingReminders().catch((error) => {
      console.error('[reminders] check failed:', error && (error.stack || error.message || error));
    });
  }, REMINDER_CHECK_INTERVAL_MS);

  checkBookingReminders().catch((error) => {
    console.error('[reminders] initial check failed:', error && (error.stack || error.message || error));
  });
}

function createDailyBackup() {
  const source = path.join(__dirname, 'bookings.json');
  if (!fs.existsSync(source)) {
    return;
  }

  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const target = path.join(backupDir, `bookings-${datePart}.json`);

  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
    console.log(`[backup] created ${target}`);
  }
}

async function migrateBookings() {
  await updateBookings((bookings) => {
    let changed = false;

    bookings.forEach((booking) => {
      if (!booking.status) {
        booking.status = booking.deletedAt ? 'deleted' : 'active';
        changed = true;
      }
      if (typeof booking.title !== 'string') {
        booking.title = '';
        changed = true;
      }
      if (typeof booking.note !== 'string') {
        booking.note = '';
        changed = true;
      }
    });

    return { changed };
  });
}

async function handleCallbackQuery(query) {
  if (!query.message || !query.message.chat) {
    await bot.answerCallbackQuery(query.id).catch((error) => {
      console.warn('[telegram] answerCallbackQuery failed:', error.message);
    });
    return;
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;
  const username = query.from.username || null;

  await bot.answerCallbackQuery(query.id).catch((error) => {
    console.warn('[telegram] answerCallbackQuery failed:', error.message);
  });

  const state = userStates[chatId] || {};
  userStates[chatId] = state;

  if (data === 'start_booking') {
    console.log('[booking] start_booking', { chatId, userId, username });
    userStates[chatId] = { mode: 'booking', cart: [] };
    sendMessage(chatId, 'Выберите оборудование (можно несколько):', {
      reply_markup: equipmentKeyboard(products),
    });

    return;
  }

  if (data === 'my_bookings') {
    console.log('[booking] my_bookings requested', { chatId, userId, username });
    const bookings = await loadBookings();
    const myBookings = sortBookingsByStart(bookings.filter((b) => b.userId === userId && isActiveBooking(b)));

    if (myBookings.length === 0) {
      sendMessage(chatId, 'У вас пока нет броней.', {
        reply_markup: mainMenuAndBookKeyboard(),
      });
      return;
    }

    let text = 'Ваши брони:\n\n';
    myBookings.forEach((b, i) => {
      text += `${formatBookingLine(b, i)}\n\n`;
    });

    await sendLongMessage(chatId, text, {
      reply_markup: myBookingsKeyboard(myBookings),
    });

    return;
  }


  if (data === 'view_by_date') {
    console.log('[booking] view_by_date started', { chatId, userId, username });
    startAllBookingsDateView(chatId, query.message);
    return;
  }

  if (data === 'main_menu') {
    delete userStates[chatId];
    showMainMenu(chatId, userId);
    return;
  }

  if (data === 'back:items' && (state.mode === 'booking' || state.mode === 'booking_enter_title')) {
    state.mode = 'booking';
    const selected = (state.cart || []).map((k) => products[k]).join('\n• ') || 'ничего не выбрано';

    sendMessage(chatId, `Выбрано:\n• ${selected}\n\nПродолжить?`, {
      reply_markup: equipmentKeyboard(products, state.cart || []),
    });
    return;
  }

  if (data.startsWith('add:') && state.mode === 'booking') {
    const key = data.slice(4);
    console.log('[booking] add/remove item', { chatId, userId, key, currentCart: state.cart });
    if (state.cart.includes(key)) {
      state.cart = state.cart.filter((k) => k !== key);
    } else {
      state.cart.push(key);
    }

    const selected = state.cart.map((k) => products[k]).join('\n• ') || 'ничего не выбрано';
    editMessageText(`Выбрано:\n• ${selected}\n\nПродолжить?`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: equipmentKeyboard(products, state.cart),
    });
    return;
  }

  if (data === 'next:date' && state.mode === 'booking') {
    console.log('[booking] next:date', { chatId, userId, cart: state.cart });
    if (!state.cart || state.cart.length === 0) {
      sendMessage(chatId, 'Выберите хотя бы один товар!', {
        reply_markup: equipmentKeyboard(products, state.cart || []),
      });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(state, 'title')) {
      startDateSelection(chatId, query.message, state);
      return;
    }

    state.mode = 'booking_enter_title';
    sendMessage(chatId, 'Введите название съемки:', {
      reply_markup: titleKeyboard(),
    });
    return;
  }

  if (data === 'skip:title' && state.mode === 'booking_enter_title') {
    state.title = '';
    startNoteEntry(chatId, state);
    return;
  }

  if (data === 'skip:note' && state.mode === 'booking_enter_note') {
    state.note = '';
    startDateSelection(chatId, query.message, state);
    return;
  }

  if (data === 'confirm_booking') {
    await savePendingBooking(chatId, userId, username, state);
    return;
  }

  if (data === 'cancel_booking') {
    delete userStates[chatId];
    sendMessage(chatId, 'Бронирование отменено.', {
      reply_markup: mainMenuOnlyKeyboard(),
    });
    return;
  }

  if (calendar.chats.has(chatId) && messageId === calendar.chats.get(chatId)) {
    const selectedDate = calendar.clickButtonCalendar(query);
    if (selectedDate === -1) {
      return;
    }

    if (state.mode === 'booking_select_start_date') {
      if (isDateInPast(selectedDate)) {
        sendMessage(chatId, '❌ Нельзя бронировать дату в прошлом. Выберите другую дату.', {
          reply_markup: mainMenuOnlyKeyboard(),
        });
        calendar.startNavCalendar(query.message);
        return;
      }

      state.startDate = selectedDate;
      sendMessage(chatId, `Выбрана дата: ${selectedDate}\n\nБронировать на несколько дней?`, {
        reply_markup: bookingPeriodKeyboard(),
      });
      return;
    }

    if (state.mode === 'view_date') {
      const onDate = sortBookingsByStart(getActiveBookings(await loadBookings())
        .filter((booking) => bookingMatchesDate(booking, selectedDate)));

      if (onDate.length === 0) {
        sendMessage(chatId, `На ${selectedDate} броней нет.`, {
          reply_markup: mainMenuOnlyKeyboard(),
        });
      } else {
        await sendLongMessage(chatId, formatBookingsList(`Брони на ${selectedDate}:`, onDate), {
          reply_markup: mainMenuOnlyKeyboard(),
        });
      }

      delete userStates[chatId];
      return;
    }

    if (state.mode === 'booking_select_end_date') {
      console.log('[booking] selected end date', { chatId, userId, startDate: state.startDate, endDate: selectedDate });
      const startDateObj = parseDateDMY(state.startDate);
      const endDateObj = parseDateDMY(selectedDate);

      if (endDateObj < startDateObj) {
        sendMessage(chatId, '❌ Конец периода не может быть раньше начала. Выберите корректную дату.', {
          reply_markup: mainMenuOnlyKeyboard(),
        });
        calendar.startNavCalendar(query.message);
        return;
      }

      state.endDate = selectedDate;

      // Если это мульти-дневная брони (разные даты) - сохранить без выбора времени
      if (state.startDate !== state.endDate) {
        state.startTime = '09:00';
        state.endTime = '22:00';
        state.pendingBooking = buildBookingDraftFromState(state, userId, username);

        sendMessage(chatId, formatBookingSummaryFromState(state), {
          reply_markup: bookingConfirmKeyboard(),
        });
        return;
      }

      // Если это одна дата - показать выбор времени
      state.mode = 'booking';
      state.selectedDate = state.startDate;

      const now = new Date();
      const selectedDateObj2 = parseDateDMY(state.startDate);
      let startMinute = TIME_START_HOUR * 60;

      if (isSameDay(selectedDateObj2, now)) {
        const candidate = getNextHalfHourMinutes();
        if (candidate > startMinute) startMinute = candidate;
      }

      const startTimeKeyboard = timeKeyboard({
        startMinute,
        endHour: TIME_END_HOUR,
        minDuration: MIN_DURATION_MINUTES,
        columns: TIME_GRID_COLUMNS,
        backText: '↩️ К выбору дат',
        backCallback: 'next:date',
      });

      if (startTimeKeyboard.inline_keyboard.length === 0) {
        sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.', {
          reply_markup: mainMenuOnlyKeyboard(),
        });
        state.mode = 'booking_select_start_date';
        delete state.startDate;
        delete state.endDate;
        return;
      }

      sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: startTimeKeyboard,
      });
      return;
    }


    if (state.mode === 'booking' && state.selectedDate) {
      if (!state.cart || state.cart.length === 0) {
        sendMessage(chatId, 'Сначала выберите оборудование.', {
          reply_markup: equipmentKeyboard(products, state.cart || []),
        });
        return;
      }

      const now = new Date();
      const selectedDateObj = parseDateDMY(selectedDate);
      let startMinute = TIME_START_HOUR * 60;

      if (isSameDay(selectedDateObj, now)) {
        const candidate = getNextHalfHourMinutes();
        if (candidate > startMinute) startMinute = candidate;
      }

      const startTimeKeyboard = timeKeyboard({
        startMinute,
        endHour: TIME_END_HOUR,
        minDuration: MIN_DURATION_MINUTES,
        columns: TIME_GRID_COLUMNS,
        backText: '↩️ К выбору даты',
        backCallback: 'next:date',
      });

      if (startTimeKeyboard.inline_keyboard.length === 0) {
        sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.', {
          reply_markup: mainMenuAndBookKeyboard(),
        });
        delete userStates[chatId];
        return;
      }

      sendMessage(chatId, `Дата: ${selectedDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: startTimeKeyboard,
      });
      return;
    }
  }

  if (data.startsWith('start_time:') && state.mode === 'booking') {
    if (!state.selectedDate && !(state.startDate && state.endDate)) {
      sendMessage(chatId, 'Выберите дату перед временем.', {
        reply_markup: mainMenuAndBookKeyboard(),
      });
      return;
    }

    const startTime = data.substring('start_time:'.length);
    state.startTime = startTime;

    const startMin = timeToMinutes(startTime);
    const endTimeMarkup = endTimeKeyboard({
      startMinute: startMin,
      endHour: TIME_END_HOUR,
      minDuration: MIN_DURATION_MINUTES,
      columns: TIME_GRID_COLUMNS,
      backText: '↩️ К выбору времени начала',
      backCallback: 'booking_single_day',
    });

    if (endTimeMarkup.inline_keyboard.length === 0) {
      sendMessage(chatId, 'Для выбранного времени начала нет доступных вариантов окончания. Попробуйте более раннее время.', {
        reply_markup: mainMenuOnlyKeyboard(),
      });
      return;
    }

    sendMessage(chatId, `Начало: ${startTime}\nВыберите **время окончания** (минимум ${MIN_DURATION_MINUTES} мин):`, {
      parse_mode: 'Markdown',
      reply_markup: endTimeMarkup,
    });
    return;
  }

  if (data.startsWith('end_time:') && state.mode === 'booking') {
    if (!state.startTime) {
      sendMessage(chatId, 'Выберите время начала перед окончанием.', {
        reply_markup: mainMenuAndBookKeyboard(),
      });
      return;
    }

    const endTime = data.substring('end_time:'.length);
    const startMin = timeToMinutes(state.startTime);
    const endMin = timeToMinutes(endTime);

    if (endMin - startMin < MIN_DURATION_MINUTES) {
      sendMessage(chatId, `Минимальная длительность брони — ${MIN_DURATION_MINUTES} минут.`, {
        reply_markup: mainMenuOnlyKeyboard(),
      });
      return;
    }

    state.endTime = endTime;
    state.pendingBooking = buildBookingDraftFromState(state, userId, username);

    sendMessage(chatId, formatBookingSummaryFromState(state), {
      reply_markup: bookingConfirmKeyboard(),
    });

    return;
  }

  if (data === 'booking_select_multiple') {
    if (!state.startDate) {
      sendMessage(chatId, 'Выберите дату начала сначала.', {
        reply_markup: mainMenuAndBookKeyboard(),
      });
      return;
    }
    state.mode = 'booking_select_end_date';
    sendMessage(chatId, 'Теперь выберите **конец** периода бронирования:', {
      parse_mode: 'Markdown',
    });
    calendar.startNavCalendar(query.message);
    return;
  }

  if (data === 'booking_single_day') {
    if (!state.startDate) {
      sendMessage(chatId, 'Выберите дату сначала.', {
        reply_markup: mainMenuAndBookKeyboard(),
      });
      return;
    }
    state.endDate = state.startDate;
    state.mode = 'booking';
    state.selectedDate = state.startDate;

    const now = new Date();
    const selectedDateObj = parseDateDMY(state.startDate);
    let startMinute = TIME_START_HOUR * 60;

    if (isSameDay(selectedDateObj, now)) {
      const candidate = getNextHalfHourMinutes();
      if (candidate > startMinute) startMinute = candidate;
    }

    const startTimeKeyboard = timeKeyboard({
      startMinute,
      endHour: TIME_END_HOUR,
      minDuration: MIN_DURATION_MINUTES,
      columns: TIME_GRID_COLUMNS,
      backText: '↩️ К выбору дат',
      backCallback: 'next:date',
    });

    if (startTimeKeyboard.inline_keyboard.length === 0) {
      sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.', {
        reply_markup: mainMenuOnlyKeyboard(),
      });
      state.mode = 'booking_select_start_date';
      delete state.startDate;
      delete state.endDate;
      return;
    }

    sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
      parse_mode: 'Markdown',
      reply_markup: startTimeKeyboard,
    });
    return;
  }

  if (data.startsWith('delete_confirm:')) {
    const bookingId = data.split(':')[1];
    const bookings = await loadBookings();
    const booking = bookings.find((b) => b.id === bookingId && isActiveBooking(b) && b.userId === userId);

    if (!booking) {
      sendMessage(chatId, 'Бронь уже удалена или не найдена.', {
        reply_markup: myBookingsReturnKeyboard(),
      });
      return;
    }

    const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;

    editMessageText(`Удалить бронь?\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${formatBookingTitleLine(booking)}${itemsNames}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: deleteConfirmKeyboard(bookingId),
    });
    return;
  }

  if (data.startsWith('delete_final:')) {
    const bookingId = data.split(':')[1];
    const deleteResult = await updateBookings((bookings) => deleteBookingById(bookings, bookingId, userId));

    if (!deleteResult.deleted) {
      sendMessage(chatId, 'Ошибка удаления: бронь не найдена или не принадлежит вам.', {
        reply_markup: myBookingsReturnKeyboard(),
      });
      return;
    }

    const booking = deleteResult.booking;

    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;
    editMessageText(`Бронь удалена:\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${formatBookingTitleLine(booking)}${booking.items.map((id) => products[id] || id).join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: afterDeleteKeyboard(),
    });


    sendMessage(chatId, 'Бронь удалена. Возврат к меню ниже.', {
      reply_markup: afterDeleteKeyboard(),
    });
    return;
  }

  if (data === 'cancel_delete') {
    editMessageText('Удаление отменено.', {
      chat_id: chatId,
      message_id: messageId,
    });
    sendMessage(chatId, 'Вернуться к списку?', {
      reply_markup: myBookingsReturnKeyboard(),
    });
    return;
  }

  sendMessage(chatId, 'Команда не распознана.', {
    reply_markup: mainMenuOnlyKeyboard(),
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) {
    return;
  }

  const state = userStates[chatId];
  if (!state || (state.mode !== 'booking_enter_title' && state.mode !== 'booking_enter_note')) {
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) {
    return;
  }

  if (state.mode === 'booking_enter_title') {
    const title = normalizeBookingTitle(msg.text);
    if (!title) {
      sendMessage(chatId, 'Введите название съемки текстом или нажмите «Пропустить».', {
        reply_markup: titleKeyboard(),
      });
      return;
    }

    state.title = title;
    startNoteEntry(chatId, state);
    return;
  }

  const note = normalizeBookingNote(msg.text);
  if (!note) {
    sendMessage(chatId, 'Введите комментарий текстом или нажмите «Пропустить».', {
      reply_markup: noteKeyboard(),
    });
    return;
  }

  state.note = note;
  startDateSelection(chatId, msg, state);
}

function attachBotErrorHandlers() {
  bot.on('polling_error', (error) => {
    console.error('[telegram] polling_error:', error && (error.stack || error.message || error));
  });

  bot.on('webhook_error', (error) => {
    console.error('[telegram] webhook_error:', error && (error.stack || error.message || error));
  });

  bot.on('error', (error) => {
    console.error('[telegram] error:', error && (error.stack || error.message || error));
  });
}

async function start() {
  bot = new TelegramBot(TOKEN, await createBotOptions());
  attachBotErrorHandlers();

  calendar = new Calendar(bot, {
    date_format: 'DD.MM.YYYY',
    language: 'ru',
    start_date: false,
    time_selector_mod: false,
  });
  patchCalendarErrorHandling(calendar);

  await createBooking();
  createDailyBackup();
  await migrateBookings();

  bot.onText(/\/start/, (msg) => resetStateAndShowMainMenu(msg.chat.id, msg.from.id));
  bot.onText(/\/book/, (msg) => resetStateAndShowMainMenu(msg.chat.id, msg.from.id));
  bot.onText(/\/all/, (msg) => startAllBookingsDateView(msg.chat.id, msg));

  bot.onText(/\/week/, (msg) => {
    handleWeekCommand(msg).catch((error) => {
      console.error('[telegram] week command failed:', error && (error.stack || error.message || error));
    });
  });
  bot.onText(/\/search\s+(.+)/, (msg, match) => {
    handleSearchCommand(msg, match).catch((error) => {
      console.error('[telegram] search command failed:', error && (error.stack || error.message || error));
    });
  });


  bot.onText(/\/free\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})/, (msg, match) => {
    handleFreeCommand(msg, match).catch((error) => {
      console.error('[telegram] free command failed:', error && (error.stack || error.message || error));
    });
  });
  bot.onText(/\/edit_title\s+(\S+)\s+(.+)/, (msg, match) => {
    handleEditTitleCommand(msg, match).catch((error) => {
      console.error('[telegram] edit title command failed:', error && (error.stack || error.message || error));
    });
  });
  bot.onText(/\/edit_note\s+(\S+)\s+(.+)/, (msg, match) => {
    handleEditNoteCommand(msg, match).catch((error) => {
      console.error('[telegram] edit note command failed:', error && (error.stack || error.message || error));
    });
  });
  bot.onText(/\/cancel/, (msg) => handleCancelCommand(msg));
  bot.on('message', (msg) => {
    handleMessage(msg).catch((error) => {
      console.error('[telegram] message handler failed:', error && (error.stack || error.message || error));
    });
  });
  bot.on('callback_query', (query) => {
    handleCallbackQuery(query).catch((error) => notifyCallbackFailure(query, error));
  });

  startReminderLoop();
  console.log('Бот запущен...');
}

start().catch((error) => {
  console.error('[process] failed to start bot:', error && (error.stack || error.message || error));
  process.exit(1);
});
