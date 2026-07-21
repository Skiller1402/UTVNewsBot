function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📅 Забронировать оборудование', callback_data: 'start_booking' }],
      [{ text: '📋 Мои брони', callback_data: 'my_bookings' }],
      [{ text: '🔍 Все брони', callback_data: 'view_by_date' }],
    ],
  };
}

function equipmentKeyboard(products, cart = []) {
  return {
    inline_keyboard: [
      ...Object.entries(products).map(([key, name]) => [
        {
          text: cart.includes(key) ? `✅ ${name}` : name,
          callback_data: `add:${key}`,
        },
      ]),
      [{ text: '➡️ Далее — дата и время', callback_data: 'next:date' }],
      [{ text: '↩️ В меню', callback_data: 'main_menu' }],
    ],
  };
}

function titleKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Пропустить', callback_data: 'skip:title' }],
      [{ text: '↩️ К выбору оборудования', callback_data: 'back:items' }],
      [{ text: '↩️ В меню', callback_data: 'main_menu' }],
    ],
  };
}

function noteKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Пропустить', callback_data: 'skip:note' }],
      [{ text: '↩️ В меню', callback_data: 'main_menu' }],
    ],
  };
}

function bookingConfirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ Подтвердить бронь', callback_data: 'confirm_booking' }],
      [{ text: '❌ Отменить', callback_data: 'cancel_booking' }],
      [{ text: '↩️ В меню', callback_data: 'main_menu' }],
    ],
  };
}

function bookingPeriodKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ Да, несколько дней', callback_data: 'booking_select_multiple' }],
      [{ text: '❌ Нет, только этот день', callback_data: 'booking_single_day' }],
      [{ text: '↩️ В меню', callback_data: 'main_menu' }],
    ],
  };
}

function mainMenuOnlyKeyboard() {
  return {
    inline_keyboard: [[{ text: '↩️ Главное меню', callback_data: 'main_menu' }]],
  };
}

function mainMenuAndBookKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📅 Забронировать оборудование', callback_data: 'start_booking' }],
      [{ text: '↩️ Главное меню', callback_data: 'main_menu' }],
    ],
  };
}

function myBookingsKeyboard(bookings) {
  return {
    inline_keyboard: [
      ...bookings
        .map((booking, index) => ({ booking, index }))
        .filter(({ booking }) => booking.status !== 'deleted' && !booking.deletedAt)
        .map(({ booking, index }) => [
          {
            text: `🗑 Удалить №${index + 1}`,
            callback_data: `delete_confirm:${booking.id}`,
          },
        ]),
      [{ text: '↩️ Главное меню', callback_data: 'main_menu' }],
    ],
  };
}

function timeKeyboard({
  startMinute,
  endHour,
  minDuration,
  columns,
  backText,
  backCallback,
}) {
  const keyboard = [];
  let row = [];

  for (let minutes = startMinute; minutes <= endHour * 60 - minDuration; minutes += 30) {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    const time = `${h}:${m}`;
    row.push({ text: time, callback_data: `start_time:${time}` });

    if (row.length === columns) {
      keyboard.push(row);
      row = [];
    }
  }

  if (row.length) {
    keyboard.push(row);
  }

  if (keyboard.length > 0) {
    keyboard.push([{ text: backText, callback_data: backCallback }], [{ text: '↩️ В меню', callback_data: 'main_menu' }]);
  }

  return { inline_keyboard: keyboard };
}

function endTimeKeyboard({
  startMinute,
  endHour,
  minDuration,
  columns,
  backText,
  backCallback,
}) {
  const keyboard = [];
  let row = [];

  for (let minutes = startMinute + minDuration; minutes <= endHour * 60; minutes += 30) {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    const time = `${h}:${m}`;
    row.push({ text: time, callback_data: `end_time:${time}` });

    if (row.length === columns) {
      keyboard.push(row);
      row = [];
    }
  }

  if (row.length) {
    keyboard.push(row);
  }

  if (keyboard.length > 0) {
    if (backText && backCallback) {
      keyboard.push([{ text: backText, callback_data: backCallback }]);
    }
    keyboard.push([{ text: '↩️ В меню', callback_data: 'main_menu' }]);
  }

  return { inline_keyboard: keyboard };
}

function deleteConfirmKeyboard(bookingId) {
  return {
    inline_keyboard: [[
      { text: '❌ Нет', callback_data: 'cancel_delete' },
      { text: '✅ Да, удалить', callback_data: `delete_final:${bookingId}` },
    ]],
  };
}

function afterDeleteKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '← Мои брони', callback_data: 'my_bookings' }],
      [{ text: '↩️ Главное меню', callback_data: 'main_menu' }],
    ],
  };
}

function myBookingsReturnKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📋 Мои брони', callback_data: 'my_bookings' }],
      [{ text: '↩️ Главное меню', callback_data: 'main_menu' }],
    ],
  };
}

module.exports = {
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
};
