/**
 * Zoom Workspace Appointments Management Engine
 * Architecture Reference: Layer 2 (Appointments View & Overlap Prevention Engine)
 */

const express = require('express');
const router = express.Router();

// ==========================================
// 9) IN-MEMORY CALENDAR PERSISTENCE REGISTER
// ==========================================
const providerSchedules = new Map(); // Store host operational settings
const bookedAppointments = new Map(); // Store confirmed consumer bookings

// Seed initial mock configuration data for Host Jane Doe upon boot
providerSchedules.set('host_jane_doe', {
    weeklyAvailability: [
        { dayOfWeek: 1, start: "09:00", end: "17:00" }, // Monday
        { dayOfWeek: 2, start: "09:00", end: "17:00" }, // Tuesday
        { dayOfWeek: 3, start: "09:00", end: "17:00" }, // Wednesday
        { dayOfWeek: 4, start: "09:00", end: "17:00" }, // Thursday
        { dayOfWeek: 5, start: "09:00", end: "16:00" }  // Friday
    ],
    defaultSlotDuration: 30, // minutes
    bufferTime: 15          // padding minutes between meetings
});

// Seed an existing appointment entry to verify the overlap prevention algorithm
bookedAppointments.set('host_jane_doe', [
    {
        appointmentId: 'apt_mock_9912',
        topic: 'Existing Thesis Check-in',
        startTime: new Date('2026-10-22T15:30:00Z'), // Oct 22, 2026, 3:30 PM UTC
        endTime: new Date('2026-10-22T16:00:00Z')   // Oct 22, 2026, 4:00 PM UTC
    }
]);

// ==========================================
// UTILITY MATH MATRIX FUNCTIONS
// ==========================================

/**
 * Validates if two time periods run into each other
 */
function isOverlapping(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
}

// ==========================================
// REST CORE API ROUTING ENDPOINTS
// ==========================================

/**
 * 🛠️ Endpoint 1: Fetch and Calculate Bookable Slots for a Specific Date
 * Compiles master profile rules, slices calendar periods, filters existing conflicts.
 */
// v4.6.1: scheduling belongs to signed-in accounts. Guests hold a meeting-scoped session only; they cannot read availability or book.
const requireAccount = (req, res, next) => {
    if (!req.actor) return res.status(401).json({ error: 'Sign in to use scheduling.' });
    if (req.actor.type !== 'account') return res.status(403).json({ error: 'Scheduling is not available to guests.' });
    next();
};
const MAX_BOOKINGS_PER_ACCOUNT = 50;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

router.get('/slots', requireAccount, (req, res) => {
    const { hostId, date } = req.query; // Expects date format: YYYY-MM-DD
    if (typeof hostId !== 'string' || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        return res.status(400).json({ error: "hostId and a YYYY-MM-DD date are required." });
    }

    if (!hostId || !date) {
        return res.status(400).json({ error: "Missing required parameters: hostId and target date window." });
    }

    const hostRules = providerSchedules.get(hostId);
    if (!hostRules) {
        return res.status(404).json({ error: "Host profile scheduling framework template not found." });
    }

    const targetDate = new Date(date);
    const dayOfWeek = targetDate.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.

    // Identify day configuration settings
    const dayConfig = hostRules.weeklyAvailability.find(cfg => cfg.dayOfWeek === dayOfWeek);
    if (!dayConfig) {
        return res.json({ date, message: "No operational work availability blocks declared on this calendar day.", slots: [] });
    }

    // Build standard date boundary variables
    const [startHour, startMin] = dayConfig.start.split(':').map(Number);
    const [endHour, endMin] = dayConfig.end.split(':').map(Number);

    const windowStart = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), startHour, startMin));
    const windowEnd = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), endHour, endMin));

    // Pull in already allocated periods for overlap stripping calculation
    const hostBookings = bookedAppointments.get(hostId) || [];

    const computedSlots = [];
    let currentPointer = new Date(windowStart);

    // Iterative Generation Loop
    while (currentPointer < windowEnd) {
        const slotEnd = new Date(currentPointer.getTime() + (hostRules.defaultSlotDuration * 60 * 1000));
        
        // Add padding rules to evaluate maximum overlap space boundaries
        const potentialNextPointer = new Date(slotEnd.getTime() + (hostRules.bufferTime * 60 * 1000));

        // Enforce hard calendar boundaries check
        if (slotEnd > windowEnd) break;

        // Check potential slot against existing booked intervals
        const hasConflict = hostBookings.some(booking => 
            isOverlapping(currentPointer, slotEnd, booking.startTime, booking.endTime)
        );

        computedSlots.push({
            timeStart: currentPointer.toISOString(),
            timeEnd: slotEnd.toISOString(),
            isAvailable: !hasConflict
        });

        // Advance slot window index forwards
        currentPointer = potentialNextPointer;
    }

    return res.json({
        date,
        hostId,
        durationConfiguredMinutes: hostRules.defaultSlotDuration,
        bufferAppliedMinutes: hostRules.bufferTime,
        slots: computedSlots
    });
});

/**
 * 🔒 Endpoint 2: Reserve a Specific Slot with Overlap Verification
 * Re-verifies conflict indices immediately prior to mutating memory stores to prevent race conditions.
 */
router.post('/book', requireAccount, (req, res) => {
    const { hostId, topic, startTimeString, participantEmail } = req.body || {};

    if (typeof hostId !== 'string' || typeof topic !== 'string' || !topic.trim() || topic.length > 200 || typeof startTimeString !== 'string') {
        return res.status(400).json({ error: "Missing required core slot routing details." });
    }
    if (participantEmail !== undefined && (typeof participantEmail !== 'string' || !EMAIL_RE.test(participantEmail))) {
        return res.status(400).json({ error: "participantEmail is not a valid address." });
    }
    const start = Date.parse(startTimeString);
    if (Number.isNaN(start) || start < Date.now() - 60 * 1000 || start > Date.now() + 366 * 24 * 3600 * 1000) {
        return res.status(400).json({ error: "The requested time must be in the next 12 months." });
    }
    let mine = 0; for (const list of bookedAppointments.values()) for (const b of list) if (b.bookedBy === req.actor.id) mine++;
    if (mine >= MAX_BOOKINGS_PER_ACCOUNT) return res.status(429).json({ error: "Booking limit reached for this account." });

    const hostRules = providerSchedules.get(hostId);
    if (!hostRules) return res.status(404).json({ error: "Host scheduling rule metrics missing." });

    const requestedStart = new Date(startTimeString);
    const requestedEnd = new Date(requestedStart.getTime() + (hostRules.defaultSlotDuration * 60 * 1000));

    // Pull up-to-date schedule entries
    if (!bookedAppointments.has(hostId)) {
        bookedAppointments.set(hostId, []);
    }
    const currentBookings = bookedAppointments.get(hostId);

    // Race-condition fallback: Double check conflict index space
    const doubleCheckConflict = currentBookings.some(booking => 
        isOverlapping(requestedStart, requestedEnd, booking.startTime, booking.endTime)
    );

    if (doubleCheckConflict) {
        return res.status(409).json({ 
            success: false, 
            error: "Scheduling Collapsed. The requested slot timespace was reserved by another process while resolving your selection." 
        });
    }

    // Allocate persistent memory reference mapping block
    const confirmedBooking = {
        appointmentId: 'apt_' + Math.random().toString(36).substring(2, 11),
        topic,
        startTime: requestedStart,
        endTime: requestedEnd,
        participantEmail: participantEmail || 'unregistered@workspace.internal',
        bookedBy: req.actor.id,
        createdAt: new Date()
    };

    currentBookings.push(confirmedBooking);

    // Layer 8: Push event down Notification pipeline triggers (Mock alert)
    console.log(`[Notification Dispatch]: Appointment Confirmation Email and Meeting Link pushed to ${confirmedBooking.participantEmail}`);

    return res.status(201).json({
        success: true,
        message: "Calendar slot locked successfully.",
        bookingDetail: {
            id: confirmedBooking.appointmentId,
            topic: confirmedBooking.topic,
            startsAt: confirmedBooking.startTime.toISOString(),
            endsAt: confirmedBooking.endTime.toISOString()
        }
    });
});

module.exports = router;