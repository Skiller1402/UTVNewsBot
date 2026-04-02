const path = require('path');

require('dotenv').config({
  path: path.join(process.cwd(), '.env'), 
});

const TelegramBot = require('node-telegram-bot-api');
const Calendar = require('telegram-inline-calendar');
const { v4: uuidv4 } = require('uuid');
const { loadBookings, saveBookings } = require('./storage');
const { timeToMinutes, minutesToTime, intervalsOverlap } = require('./timeUtils');

// 

const { createBooking } = require('./createBooking');

// 

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN не установлен. Создайте .env с BOT_TOKEN=...');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const MIN_DURATION_MINUTES = 30;
const TIME_GRID_COLUMNS = 5;
const TIME_START_HOUR = 9;
const TIME_END_HOUR = 22;

const calendar = new Calendar(bot, {
  date_format: 'DD.MM.YYYY',
  language: 'ru',
  start_date: new Date(),
  time_selector_mod: false,
});

// 

createBooking()

// 


function parseDateDMY(dateStr) {
  const [d, m, y] = dateStr.split('.').map(Number);
  return new Date(y, m - 1, d);
}

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

const userStates = {};

const products = {
  iphone15: 'iPhone 15 Pro Max',
  iphone16: 'iPhone 16 Pro Max',
  djimic: 'DJI Mic 2',
  light: 'Накамерный свет',
};

function showMainMenu(chatId) {
  bot.sendMessage(chatId, 'Выберите действие:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Забронировать оборудование', callback_data: 'start_booking' }],
        [{ text: '📋 Мои брони', callback_data: 'my_bookings' }],
        [{ text: '🔍 Все брони', callback_data: 'view_by_date' }],
      ],
    },
  });
}

bot.onText(/\/start/, (msg) => showMainMenu(msg.chat.id));
bot.onText(/\/book/, (msg) => showMainMenu(msg.chat.id));

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;
  const username = query.from.username || null;

  await bot.answerCallbackQuery(query.id);

  const state = userStates[chatId] || {};
  userStates[chatId] = state;

  if (data === 'start_booking') {
    console.log('[booking] start_booking', { chatId, userId, username });
    userStates[chatId] = { mode: 'booking', cart: [] };
    const keyboard = Object.entries(products).map(([key, name]) => [{ text: name, callback_data: `add:${key}` }]);
    keyboard.push([{ text: '➡️ Далее — дата и время', callback_data: 'next:date' }]);
    keyboard.push([{ text: '↩️ В меню', callback_data: 'main_menu' }]);

    bot.sendMessage(chatId, 'Выберите оборудование (можно несколько):', {
      reply_markup: { inline_keyboard: keyboard },
    });

    return;
  }

  if (data === 'my_bookings') {
    console.log('[booking] my_bookings requested', { chatId, userId, username });
    const bookings = await loadBookings();
    const myBookings = bookings.filter((b) => b.userId === userId);

    if (myBookings.length === 0) {
      bot.sendMessage(chatId, 'У вас пока нет броней.');
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

    bot.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
    });

    return;
  }

  if (data === 'view_by_date') {
    console.log('[booking] view_by_date started', { chatId, userId, username });
    userStates[chatId] = { mode: 'view_date' };
    bot.sendMessage(chatId, 'Выберите дату для просмотра броней:');
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

    bot.sendMessage(chatId, `Выбрано:\n• ${selected}\n\nПродолжить?`, {
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
    bot.editMessageText(`Выбрано:\n• ${selected}\n\nПродолжить?`, {
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
      bot.sendMessage(chatId, 'Выберите хотя бы один товар!');
      return;
    }

    state.mode = 'booking_select_start_date';
    bot.sendMessage(chatId, 'Выберите **начало** периода бронирования:', {
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
      bot.sendMessage(chatId, `Выбрана дата: ${selectedDate}\n\nБронировать на несколько дней?`, {
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
        bot.sendMessage(chatId, '❌ Конец периода не может быть раньше начала. Выберите корректную дату.');
        calendar.startNavCalendar(query.message);
        return;
      }

      state.endDate = selectedDate;

      // Если это мульти-дневная брони (разные даты) - сохранить без выбора времени
      if (state.startDate !== state.endDate) {
        const bookings = await loadBookings();

        const allDates = getAllDatesInRange(state.startDate, state.endDate);
        const startMin = timeToMinutes('09:00');
        const endMin = timeToMinutes('22:00');
        const conflict = allDates.some((date) =>
          bookings.some((b) => isBookingConflict(b, date, startMin, endMin, state.cart))
        );

        if (conflict) {
          bot.sendMessage(chatId, '❌ Конфликт: выбранные позиции уже зарезервированы на часть периода. Выберите другой диапазон или другой товар.');
          return;
        }

        const newBooking = {
          id: uuidv4(),
          userId,
          username,
          startDate: state.startDate,
          endDate: state.endDate,
          startTime: '09:00',
          endTime: '22:00',
          items: [...state.cart],
          createdAt: new Date().toISOString(),
        };

        bookings.push(newBooking);
        await saveBookings(bookings);

        const itemsNames = state.cart.map((id) => products[id]).join(', ');
        bot.sendMessage(chatId, `✅ Успешно забронировано!\n\nОборудование: ${itemsNames}\nКогда: ${state.startDate} — ${state.endDate} (полный день 09:00–22:00)`, {
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
        bot.sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
        state.mode = 'booking_select_start_date';
        delete state.startDate;
        delete state.endDate;
        return;
      }

      timeKeyboard.push([{ text: '↩️ К выбору дат', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

      bot.sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: timeKeyboard },
      });
      return;
    }

    if (state.mode === 'view_date') {
      const bookings = await loadBookings();
      const onDate = bookings.filter((b) => bookingMatchesDate(b, selectedDate));

      if (onDate.length === 0) {
        bot.sendMessage(chatId, `На ${selectedDate} броней нет.`, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]] },
        });
      } else {
        let txt = `Брони на ${selectedDate}:\n\n`;
        onDate.forEach((b, i) => {
          const who = b.username ? `@${b.username}` : `ID ${b.userId}`;
          const dateExp = b.startDate && b.endDate ? `${b.startDate} — ${b.endDate}` : b.date || selectedDate;
          txt += `${i + 1}. ${dateExp} ${b.startTime}–${b.endTime} — ${b.items.map((id) => products[id] || id).join(', ')} (${who})\n`;
        });
        bot.sendMessage(chatId, txt, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]] },
        });
      }

      delete userStates[chatId];
      return;
    }

    if (state.mode === 'booking' && state.selectedDate) {
      if (!state.cart || state.cart.length === 0) {
        bot.sendMessage(chatId, 'Сначала выберите оборудование.');
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
        bot.sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
        delete userStates[chatId];
        return;
      }

      timeKeyboard.push([{ text: '↩️ К выбору даты', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

      bot.sendMessage(chatId, `Дата: ${selectedDate}\n\nВыберите **время начала**:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: timeKeyboard },
      });
      return;
    }
  }

  if (data.startsWith('start_time:') && state.mode === 'booking') {
    if (!state.selectedDate && !(state.startDate && state.endDate)) {
      bot.sendMessage(chatId, 'Выберите дату перед временем.');
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
      bot.sendMessage(chatId, 'Для выбранного времени начала нет доступных вариантов окончания. Попробуйте более раннее время.');
      return;
    }

    bot.sendMessage(chatId, `Начало: ${startTime}\nВыберите **время окончания** (минимум ${MIN_DURATION_MINUTES} мин):`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: timeKeyboard },
    });
    return;
  }

  if (data.startsWith('end_time:') && state.mode === 'booking') {
    if (!state.startTime) {
      bot.sendMessage(chatId, 'Выберите время начала перед окончанием.');
      return;
    }

    const endTime = data.substring('end_time:'.length);
    const startMin = timeToMinutes(state.startTime);
    const endMin = timeToMinutes(endTime);

    if (endMin - startMin < MIN_DURATION_MINUTES) {
      bot.sendMessage(chatId, `Минимальная длительность брони — ${MIN_DURATION_MINUTES} минут.`);
      return;
    }

    const bookings = await loadBookings();
      let conflict = false;

      if (state.startDate && state.endDate) {
        const allDates = getAllDatesInRange(state.startDate, state.endDate);
        conflict = allDates.some((dateStr) =>
          bookings.some((b) => isBookingConflict(b, dateStr, startMin, endMin, state.cart))
        );
      } else if (state.selectedDate) {
        conflict = bookings.some((b) => isBookingConflict(b, state.selectedDate, startMin, endMin, state.cart));
      }

      if (conflict) {
        console.log('[booking] time conflict', { chatId, userId, date: state.selectedDate || state.startDate, startTime: state.startTime, endTime, items: state.cart });
        bot.sendMessage(chatId, `❌ Время ${state.startTime}–${endTime} пересекается с другой бронью той же позиции.`);
        return;
      }

      const newBooking = {
        id: uuidv4(),
        userId,
        username,
        startTime: state.startTime,
        endTime,
        items: [...state.cart],
        createdAt: new Date().toISOString(),
      };

      if (state.startDate && state.endDate) {
        newBooking.startDate = state.startDate;
        newBooking.endDate = state.endDate;
      } else {
        newBooking.date = state.selectedDate;
      }

      bookings.push(newBooking);
      await saveBookings(bookings);
      console.log('[booking] saved', { chatId, userId, booking: newBooking });

      const itemsNames = state.cart.map((id) => products[id]).join(', ');
      const dateDisplay = (state.startDate && state.endDate) ? 
        `${state.startDate} — ${state.endDate}` : 
        state.selectedDate;
      bot.sendMessage(chatId, `✅ Успешно забронировано!\n\nОборудование: ${itemsNames}\nКогда: ${dateDisplay} ${state.startTime} – ${endTime}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]],
        },
      });

      delete userStates[chatId];
      return;
    }

  if (data === 'booking_select_multiple') {
    if (!state.startDate) {
      bot.sendMessage(chatId, 'Выберите дату начала сначала.');
      return;
    }
    state.mode = 'booking_select_end_date';
    bot.sendMessage(chatId, 'Теперь выберите **конец** периода бронирования:', {
      parse_mode: 'Markdown',
    });
    calendar.startNavCalendar(query.message);
    return;
  }

  if (data === 'booking_single_day') {
    if (!state.startDate) {
      bot.sendMessage(chatId, 'Выберите дату сначала.');
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
      bot.sendMessage(chatId, 'Для выбранной даты нет доступного времени начала. Пожалуйста, выберите другую дату.');
      state.mode = 'booking_select_start_date';
      delete state.startDate;
      delete state.endDate;
      return;
    }

    timeKeyboard.push([{ text: '↩️ К выбору дат', callback_data: 'next:date' }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);

    bot.sendMessage(chatId, `Дата: ${state.startDate}\n\nВыберите **время начала**:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: timeKeyboard },
    });
    return;
  }

  if (data.startsWith('delete_confirm:')) {
    const bookingId = data.split(':')[1];
    const bookings = await loadBookings();
    const booking = bookings.find((b) => b.id === bookingId);

    const itemsNames = booking.items.map((id) => products[id] || id).join(', ');
    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;

    bot.editMessageText(`Удалить бронь?\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${itemsNames}`, {
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
    const bookings = await loadBookings();
    const idx = bookings.findIndex((b) => b.id === bookingId);

    if (idx === -1 || bookings[idx].userId !== userId) {
      bot.sendMessage(chatId, 'Ошибка удаления: бронь не найдена или не принадлежит вам.');
      return;
    }

    const booking = bookings[idx];
    bookings.splice(idx, 1);
    await saveBookings(bookings);

    const dateDisplay = booking.startDate && booking.endDate ? `${booking.startDate} — ${booking.endDate}` : booking.date;
    bot.editMessageText(`Бронь удалена:\n\n${dateDisplay} ${booking.startTime}–${booking.endTime}\n${booking.items.map((id) => products[id] || id).join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '← Мои брони', callback_data: 'my_bookings' }],
          [{ text: '↩️ Главное меню', callback_data: 'main_menu' }]
        ],
      },
    });

    bot.sendMessage(chatId, 'Бронь удалена. Возврат к меню ниже.');
    return;
  }

  if (data === 'cancel_delete') {
    bot.editMessageText('Удаление отменено.', {
      chat_id: chatId,
      message_id: messageId,
    });
    bot.sendMessage(chatId, 'Вернуться к списку?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Мои брони', callback_data: 'my_bookings' }]],
      },
    });
    return;
  }

  bot.sendMessage(chatId, 'Команда не распознана. /start для меню.');
});

console.log('Бот запущен...');
