const path = require('path');
const fs = require('fs');


async function createBooking() {
    try {

    const pathToBookings = path.join(__dirname, 'bookings.json');

    if (!fs.existsSync(pathToBookings)) {
        console.log('No bookings file found, creating a new one...');
        fs.writeFileSync(pathToBookings, JSON.stringify([]));
        return
    }

    console.log('Bookings file found, creating a new booking...');
    return { success: true, message: 'Booking created successfully' };

        
    } catch (error) {
        console.error('Error creating booking:', error.message);
        return { success: false, message: 'Error creating booking' };
    }
}

module.exports = { createBooking };