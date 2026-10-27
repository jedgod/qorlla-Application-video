/**
 * Zoom Workspace Notification & Alert Hook Engine
 * Architecture Reference: Layer 8 (Notification Flow) & Layer 9 (Data Flow)
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// ==========================================
// 9) IN-MEMORY TRANSACTIONAL LOG REGISTRY
// ==========================================
const notificationLogHistory = [];

// Mock user directory registry metadata mapping out target contact profiles
const userContactDirectoryMock = new Map([
    ['usr_jane_doe', { email: 'jane.doe@workspace.internal', pushEnabled: true, name: 'Jane Doe' }],
    ['usr_participant_b', { email: 'team.member.b@workspace.internal', pushEnabled: true, name: 'Alex Smith' }]
]);

// ==========================================
// SYSTEM DISPATCH INTEGRATION MECHANISMS
// ==========================================

/**
 * Dispatches simulated transactional emails through provider integrations (e.g., SendGrid, Nodemailer)
 */
function triggerEmailPipelineGateway(recipientEmail, alertSubject, textBody) {
    // External transactional delivery simulation checkpoint
    console.log(`[Email Transport Service] Outbound message committed to queue.`);
    console.log(`     To: ${recipientEmail}\n     Subject: ${alertSubject}\n     Body Snippet: ${textBody.substring(0, 75)}...`);
    return true;
}

/**
 * Master Routing Engine core for incoming systemic updates
 */
function orchestrateNotificationDispatch(payload) {
    const { eventType, recipientUserId, metadata } = payload;
    const userProfile = userContactDirectoryMock.get(recipientUserId);
    
    if (!userProfile) {
        console.error(`[Notification Router Error]: Recipient reference ${recipientUserId} is unknown inside directory stores.`);
        return false;
    }

    const uniqueNotificationId = `ntf_${uuidv4().substring(0, 8)}`;
    let generatedSubject = "Workspace Alert";
    let generatedBodyText = "A workspace modification occurs within your active dashboard channel layout.";

    // Layer 8: Context Mapping Framework
    switch (eventType) {
        case 'MEETING_INVITE':
            generatedSubject = `📅 Invitation: ${metadata.topic}`;
            generatedBodyText = `You have been added to a new meeting block slot scheduled for ${metadata.scheduledTime}. Join using link token: ${metadata.joinUrl}`;
            break;
            
        case 'CHAT_MENTION':
            generatedSubject = `💬 Mentioned by ${metadata.senderName} in Chat`;
            generatedBodyText = `"${metadata.messageText}" - Review the live drawer logs immediately in meeting tracking ID: ${metadata.meetingId}`;
            break;
            
        case 'DOCUMENT_UPLOADED':
            generatedSubject = `📁 Asset Uploaded: ${metadata.fileName}`;
            generatedBodyText = `${metadata.uploaderName} attached a new shared file asset resource tracking layer to your session layout.`;
            break;
            
        case 'SUMMARY_COMPLETED':
            generatedSubject = `✨ AI Summary and Transcript Ready: ${metadata.topic}`;
            generatedBodyText = `The structural AI summary abstract and derived action points are compiled. Cloud video file asset streaming link: ${metadata.recordingUrl}`;
            break;

        default:
            break;
    }

    // Append to internal historical audit matrix logs
    notificationLogHistory.push({
        notificationId: uniqueNotificationId,
        recipientUserId,
        meetingId: metadata && metadata.meetingId ? String(metadata.meetingId) : null,
        recipientEmail: userProfile.email,
        eventType,
        subject: generatedSubject,
        dispatchedAt: new Date().toISOString()
    });

    // Fire Email Notification Integration Pipeline Channel Hook
    triggerEmailPipelineGateway(userProfile.email, generatedSubject, generatedBodyText);

    return {
        id: uniqueNotificationId,
        subject: generatedSubject,
        body: generatedBodyText,
        profile: userProfile
    };
}

// ==========================================
// REST CORE API ROUTING ENDPOINTS
// ==========================================

/**
 * 📣 Endpoint 1: Broadcast Notification Hook Request Trigger
 * Accepts inbound telemetry flags directly from internal microservices (Docs, Post-Meeting, WebSockets)
 */
// v4.6.1: server-to-server callers present NOTIFY_INTERNAL_TOKEN (unset = no internal caller exists). Browsers may only notify
// themselves, with an allow-listed event; guests may not trigger anything and only ever read their own meeting's notices.
const crypto = require('crypto');
const CLIENT_EVENTS = new Set(['MEETING_INVITE', 'CHAT_MENTION']);
function isInternal(req) {
    const expected = process.env.NOTIFY_INTERNAL_TOKEN || '';
    const given = String(req.get('x-internal-token') || '');
    return expected.length >= 24 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

router.post('/trigger', (req, res) => {
    const { eventType, recipientUserId, metadata } = req.body || {};

    if (!isInternal(req)) {
        if (!req.actor) return res.status(401).json({ error: 'Sign in required.' });
        if (req.actor.type !== 'account') return res.status(403).json({ error: 'Guests cannot send notifications.' });
        if (recipientUserId !== req.actor.id || !CLIENT_EVENTS.has(eventType)) return res.status(403).json({ error: 'You can only notify yourself with a supported event.' });
    }
    if (metadata && (typeof metadata !== 'object' || JSON.stringify(metadata).length > 4000)) return res.status(400).json({ error: 'metadata must be a small object.' });

    if (!eventType || !recipientUserId || !metadata) {
        return res.status(400).json({ error: "Missing required core configuration trigger payload criteria parameters." });
    }

    const dispatchResult = orchestrateNotificationDispatch({ eventType, recipientUserId, metadata });

    if (!dispatchResult) {
        return res.status(500).json({ error: "Notification routing operational path initialization failure." });
    }

    return res.status(202).json({
        success: true,
        message: "Notification compiled and dispatched down integration pipelines gracefully.",
        notificationId: dispatchResult.id,
        deliveryTarget: dispatchResult.profile.email
    });
});

/**
 * 📋 Endpoint 2: Retrieve Complete System Historical Audit Activity Log Logs
 */
router.get('/audit-log', (req, res) => {
    if (!isInternal(req)) return res.status(403).json({ error: 'The system audit log is restricted to internal callers.' });
    return res.json({
        systemTime: new Date().toISOString(),
        totalLogsTracked: notificationLogHistory.length,
        logs: notificationLogHistory.map(({ recipientEmail, ...entry }) => entry)
    });
});

// A caller sees only notices addressed to them (accounts by id; guests by their session id, and only for the meeting they joined).
router.get('/mine', (req, res) => {
    if (!req.actor) return res.status(401).json({ error: 'Sign in or join the meeting first.' });
    const mine = notificationLogHistory.filter((e) => e.recipientUserId === req.actor.id
        && (req.actor.type !== 'guest' || e.meetingId === req.actor.session.meetingId));
    return res.set('Cache-Control', 'no-store').json({ notifications: mine.map(({ recipientEmail, recipientUserId, ...entry }) => entry) });
});

module.exports = {
    router: router,
    orchestrateNotificationDispatch: orchestrateNotificationDispatch
};