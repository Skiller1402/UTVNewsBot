const path = require('path');

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
const { timeToMinutes, minutesToTime } = require('./timeUtils');
const {
  appendBookingIfAvailable,
  bookingMatchesDate,
  createBookingDraft,
  deleteBookingById,
  parseDateDMY,
} = require('./bookingService');

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

const userStates = {};

const products = {
  iphone15: 'iPhone 15 Pro Max',
  iphone16: 'iPhone 16 Pro Max',
  djimic: 'DJI Mic 2',
  djimicmini: 'DJI Mic Mini',
  light: 'Накамерный свет',
};

function showMainMenu(chatId) {
  sendMessage(chatId, 'Выберите действие:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Забронировать оборудование', callback_data: 'start_booking' }],
        [{ text: '📋 Мои брони', callback_data: 'my_bookings' }],
        [{ text: '🔍 Все брони', callback_data: 'view_by_date' }],
      ],
    },
  });
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
      await sendMessage(chatId, 'Произошла внутренняя ошибка. Попробуйте еще раз или вернитесь в меню через /start.');
    } catch (sendError) {
      console.warn('[telegram] failed to send error message:', sendError.message);
    }
  }
}

async function handleCallbackQuery(query) {
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
    const keyboard = Object.entries(products).map(([key, name]) => [{ text: name, callback_data: `add:${key}` }]);
    keyboard.push([{ text: '➡️ Далее — дата и время', callback_data: 'next:date' }]);
    keyboard.push([{ text: '↩️ В меню', callback_data: 'main_menu' }]);

    sendMessage(chatId, 'Выберите оборудование (можно несколько):', {
      reply_markup: { inline_keyboard: keyboard },
    });

    return;
  }

  if (data === 'my_bookings') {
    console.log('[booking] my_bookings requested', { chatId, userId, username });
    const bookings = await loadBookings();
    const myBookings = bookings.filter((b) => b.userId === userId);

    if (myBookings.length === 0) {
      sendMessage(chatId, 'У вас пока нет броней.');
      return;
    }

    let text = 'Ваши брони:\n\n';
    const keyboard = myBookings.map((b, i) => {
      const itemsNames = b.items.map((id) => products[id] || id).join(', ');
      const dateStr = b.startDate && b.endDate ? `${b.startDate} — ${b.endDate}` : b.date;
      text += `${i + 1}. ${dateStr} ${b.startTime}–${b.endTime}\n   ${itemsNames}\n\n`;
      return [
        {
          text: `🗑 Удалить №${i + 1}`,
          callback_data: `delete_confirm:${b.id}`,
        },
      ];
    });

    keyboard.push([{ text: '↩️ Главное меню', callback_data: 'main_menu' }]);

    sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
    });

    return;
  }

  if (data === 'view_by_date') {
    console.log('[booking] view_by_date started', { chatId, userId, username });
    userStates[chatId] = { mode: 'view_date' };
    sendMessage(chatId, 'Выберите дату для просмотра броней:');
    calendar.startNavCalendar(query.message);
    return;
  }

  if (data === 'main_menu') {
    delete userStates[chatId];
    showMainMenu(chatId);
    return;
  }

  if (data === 'back:items' && state.mode === 'booking') {
    const keyboard = Object.entries(products).map(([key, name]) => [{ text: name, callback_data: `add:${key}` }]);
    keyboard.push([{ text: '➡️ Далее — дата и время', callback_data: 'next:date' }]);
    keyboard.push([{ text: '↩️ В меню', callback_data: 'main_menu' }]);

    const selected = (state.cart || []).map((k) => products[k]).join('\n• ') || 'ничего не выбрано';

    sendMessage(chatId, `Выбрано:\n• ${selected}\n\nПродолжить?`, {
      reply_markup: { inline_keyboard: keyboard },
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
      reply_markup: {
        inline_keyboard: [
          ...Object.entries(products).map(([k, n]) => [
            {
              text: state.cart.includes(k) ? `✅ ${n}` : n,
              callback_data: `add:${k}`,
            },
          ]),
          [{ text: '➡️ Далее — дата и время', callback_data: 'next:date' }],
          [{ text: '↩️ В меню', callback_data: 'main_menu' }],
        ],
      },
    });
    return;
  }

  if (data === 'next:date' && state.mode === 'booking') {
    console.log('[booking] next:date', { chatId, userId, cart: state.cart });
    if (!state.cart || state.cart.length === 0) {
      sendMessage(chatId, 'Выберите хотя бы один товар!');
      return;
    }

    state.mode = 'booking_select_start_date';
    sendMessage(chatId, 'Выберите **начало** периода бронирования:', {
      parse_mode: 'Markdown',
    });
    calendar.startNavCalendar(query.message);
    return;
  }

  if (calendar.chats.has(chatId) && messageId === calendar.chats.get(chatId)) {
    const selectedDate = calendar.clickButtonCalendar(query);
    if (selectedDate === -1) {
      return;
    }

    if (state.mode === 'booking_select_start_date') {
      state.startDate = selectedDate;
      sendMessage(chatId, `Выбрана дата: ${selectedDate}\n\nБронировать на несколько дней?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да, несколько дней', callback_data: 'booking_select_multiple' }],
            [{ text: '❌ Нет, только этот день', callback_data: 'booking_single_day' }],
          ],
        },
      });
      return;
    }

    if (state.mode === 'booking_select_end_date') {
      console.log('[booking] selected end date', { chatId, userId, startDate: state.startDate, endDate: selectedDate });
      const startDateObj = parseDateDMY(state.startDate);
      const endDateObj = parseDateDMY(selectedDate);
      
      if (endDateObj < startDateObj) {
        sendMessage(chatId, '❌ Конец периода не может быть раньше начала. Выберите корректную дату.');
        calendar.startNavCalendar(query.message);
        return;
      }

      state.endDate = selectedDate;

      // Если это мульти-дневная брони (разные даты) - сохранить без выбора времени
      if (state.startDate !== state.endDate) {
        const bookingDraft = createBookingDraft({
          id: uuidv4(),
          userId,
          username,
          startDate: state.startDate,
          endDate: state.endDate,
          startTime: '09:00',
          endTime: '22:00',
          items: state.cart,
        });
        const bookingResult = await updateBookings((bookings) => appendBookingIfAvailable(bookings, bookingDraft));

        if (bookingResult.conflict) {
          sendMessage(chatId, '❌ Конфликт: выбранные позиции уже зарезервированы на часть периода. Выберите другой диапазон или другой товар.');
          return;
        }

        const itemsNames = state.cart.map((id) => products[id]).join(', ');
        sendMessage(chatId, `✅ Успешно забронировано!\n\nОборудование: ${itemsNames}\nКогда: ${state.startDate} — ${state.endDate} (полный день 09:00–22:00)`, {
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]],
          },
        });

        delete userStates[chatId];
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

      const timeKeyboard = [];
      let row = [];
      for (let m = startMinute; m <= TIME_END_HOUR * 60 - MIN_DURATION_MINUTES; m += 30) {
        const t = minutesToTime(m);
        row.push({ text: t, callback_data: `start_time:${t}` });
        if (row.length === TIME_GRID_COLUMNS) {
          timeKeyboard.push(row);
          row = [];
        }
      }
      if (row.length) timeKeyboard.push(row);

      if (timeKeyboard.length === 0) {
        sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
        state.mode = 'booking_select_start_date';
        delete state.startDate;
        delete state.endDate;
        return;
      }

      timeKeyboard.push([{ text: '↩️ К выбору дат', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

      sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: timeKeyboard },
      });
      return;
    }

    if (state.mode === 'view_date') {
      const bookings = await loadBookings();
      const onDate = bookings.filter((b) => bookingMatchesDate(b, selectedDate));

      if (onDate.length === 0) {
        sendMessage(chatId, `На ${selectedDate} броней нет.`, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]] },
        });
      } else {
        let txt = `Брони на ${selectedDate}:\n\n`;
        onDate.forEach((b, i) => {
          const who = b.username ? `@${b.username}` : `ID ${b.userId}`;
          const dateExp = b.startDate && b.endDate ? `${b.startDate} — ${b.endDate}` : b.date || selectedDate;
          txt += `${i + 1}. ${dateExp} ${b.startTime}–${b.endTime} — ${b.items.map((id) => products[id] || id).join(', ')} (${who})\n`;
        });
        sendMessage(chatId, txt, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]] },
        });
      }

      delete userStates[chatId];
      return;
    }

    if (state.mode === 'booking' && state.selectedDate) {
      if (!state.cart || state.cart.length === 0) {
        sendMessage(chatId, 'Сначала выберите оборудование.');
        return;
      }

      const now = new Date();
      const selectedDateObj = parseDateDMY(selectedDate);
      let startMinute = TIME_START_HOUR * 60;

      if (isSameDay(selectedDateObj, now)) {
        const candidate = getNextHalfHourMinutes();
        if (candidate > startMinute) startMinute = candidate;
      }

      const timeKeyboard = [];
      let row = [];
      for (let m = startMinute; m <= TIME_END_HOUR * 60 - MIN_DURATION_MINUTES; m += 30) {
        const t = minutesToTime(m);
        row.push({ text: t, callback_data: `start_time:${t}` });
        if (row.length === TIME_GRID_COLUMNS) {
          timeKeyboard.push(row);
          row = [];
        }
      }
      if (row.length) timeKeyboard.push(row);

      if (timeKeyboard.length === 0) {
        sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
        delete userStates[chatId];
        return;
      }

      timeKeyboard.push([{ text: '↩️ К выбору даты', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

      sendMessage(chatId, `Дата: ${selectedDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: timeKeyboard },
      });
      return;
    }
  }

  if (data.startsWith('start_time:') && state.mode === 'booking') {
    if (!state.selectedDate && !(state.startDate && state.endDate)) {
      sendMessage(chatId, 'Выберите дату перед временем.');
      return;
    }

    const startTime = data.substring('start_time:'.length);
    state.startTime = startTime;

    const startMin = timeToMinutes(startTime);
    const timeKeyboard = [];
    let row = [];

    for (let m = startMin + MIN_DURATION_MINUTES; m <= TIME_END_HOUR * 60; m += 30) {
      const t = minutesToTime(m);
      row.push({ text: t, callback_data: `end_time:${t}` });
      if (row.length === TIME_GRID_COLUMNS) {
        timeKeyboard.push(row);
        row = [];
      }
    }
    if (row.length) timeKeyboard.push(row);

    if (timeKeyboard.length === 0) {
      sendMessage(chatId, 'Для выбранного времени начала нет доступных вариантов окончания. Попробуйте более раннее время.');
      return;
    }

    sendMessage(chatId, `Начало: ${startTime}\nВыберите **время окончания** (минимум ${MIN_DURATION_MINUTES} мин):`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: timeKeyboard },
    });
    return;
  }

  if (data.startsWith('end_time:') && state.mode === 'booking') {
    if (!state.startTime) {
      sendMessage(chatId, 'Выберите время начала перед окончанием.');
      return;
    }

    const endTime = data.substring('end_time:'.length);
    const startMin = timeToMinutes(state.startTime);
    const endMin = timeToMinutes(endTime);

    if (endMin - startMin < MIN_DURATION_MINUTES) {
      sendMessage(chatId, `Минимальная длительность брони — ${MIN_DURATION_MINUTES} минут.`);
      return;
    }

    const bookingDraft = createBookingDraft({
      id: uuidv4(),
      userId,
      username,
      startTime: state.startTime,
      endTime,
      items: state.cart,
      startDate: state.startDate,
      endDate: state.endDate,
      date: state.selectedDate,
    });
    const bookingResult = await updateBookings((bookings) => appendBookingIfAvailable(bookings, bookingDraft));

    if (bookingResult.conflict) {
      console.log('[booking] time conflict', { chatId, userId, date: state.selectedDate || state.startDate, startTime: state.startTime, endTime, items: state.cart });
      sendMessage(chatId, `❌ Время ${state.startTime}–${endTime} пересекается с другой бронью той же позиции.`);
      return;
    }

    const newBooking = bookingResult.booking;
    console.log('[booking] saved', { chatId, userId, booking: newBooking });

    const itemsNames = state.cart.map((id) => products[id]).join(', ');
    const dateDisplay = (state.startDate && state.endDate) ?
      `${state.startDate} — ${state.endDate}` :
      state.selectedDate;
    sendMessage(chatId, `✅ Успешно забронировано!\n\nОборудование: ${itemsNames}\nКогда: ${dateDisplay} ${state.startTime} – ${endTime}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]],
      },
    });

    delete userStates[chatId];
    return;
  }

  if (data === 'booking_select_multiple') {
    if (!state.startDate) {
      sendMessage(chatId, 'Выберите дату начала сначала.');
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
      sendMessage(chatId, 'Выберите дату сначала.');
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

    const timeKeyboard = [];
    let row = [];
    for (let m = startMinute; m <= TIME_END_HOUR * 60 - MIN_DURATION_MINUTES; m += 30) {
      const t = minutesToTime(m);
      row.push({ text: t, callback_data: `start_time:${t}` });
      if (row.length === TIME_GRID_COLUMNS) {
        timeKeyboard.push(row);
        row = [];
      }
    }
    if (row.length) timeKeyboard.push(row);

    if (timeKeyboard.length === 0) {
      sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
      state.mode = 'booking_select_start_date';
      delete state.startDate;
      delete state.endDate;
      return;
    }

    timeKeyboard.push([{ text: '↩️ К выбору дат', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

    sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: timeKeyboard },
    });
    return;
  }

  if (data.startsWith('delete_confirm:')) {
    const bookingId = data.split(':')[1];
    const bookings = await loadBookings();
    const booking = bookings.find((b) => b.id === bookingId);

    if (!booking) {
      sendMessage(chatId, 'Бронь уже удалена или не найдена.');
      return;
    }

    const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;

    editMessageText(`Удалить бронь?\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${itemsNames}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '❌ Нет', callback_data: 'cancel_delete' },
          { text: '✅ Да, удалить', callback_data: `delete_final:${bookingId}` },
        ]],
      },
    });
    return;
  }

  if (data.startsWith('delete_final:')) {
    const bookingId = data.split(':')[1];
    const deleteResult = await updateBookings((bookings) => deleteBookingById(bookings, bookingId, userId));

    if (!deleteResult.deleted) {
      sendMessage(chatId, 'Ошибка удаления: бронь не найдена или не принадлежит вам.');
      return;
    }

    const booking = deleteResult.booking;

    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;
    editMessageText(`Бронь удалена:\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${booking.items.map((id) => products[id] || id).join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '← Мои брони', callback_data: 'my_bookings' }],
          [{ text: '↩️ Главное меню', callback_data: 'main_menu' }]
        ],
      },
    });

    sendMessage(chatId, 'Бронь удалена. Возврат к меню ниже.');
    return;
  }

  if (data === 'cancel_delete') {
    editMessageText('Удаление отменено.', {
      chat_id: chatId,
      message_id: messageId,
    });
    sendMessage(chatId, 'Вернуться к списку?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Мои брони', callback_data: 'my_bookings' }]],
      },
    });
    return;
  }

  sendMessage(chatId, 'Команда не распознана. /start для меню.');
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
    start_date: new Date(),
    time_selector_mod: false,
  });
  patchCalendarErrorHandling(calendar);

  await createBooking();

  bot.onText(/\/start/, (msg) => showMainMenu(msg.chat.id));
  bot.onText(/\/book/, (msg) => showMainMenu(msg.chat.id));
  bot.on('callback_query', (query) => {
    handleCallbackQuery(query).catch((error) => notifyCallbackFailure(query, error));
  });

  console.log('Бот запущен...');
}

start().catch((error) => {
  console.error('[process] failed to start bot:', error && (error.stack || error.message || error));
  process.exit(1);
});
