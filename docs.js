/**
 * Zoom Workspace Cloud Documentation & Asset Microservice
 * Architecture Reference: Layer 2 (Docs View) & Layer 6 (Collaboration Flow)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Configure internal transient multi-part file memory allocation rules
const storageConfig = multer.memoryStorage();
const uploadLimiter = multer({
    storage: storageConfig,
    limits: {
        fileSize: 25 * 1024 * 1024 // Enforce Layer 2 constraint: 25MB Max Asset Ceiling
    },
    fileFilter: (req, file, callback) => {
        // Strict allowlist validation filter logic
        const allowedExtensions = /\.(pdf|docx|pptx|xlsx|png|jpg|jpeg|txt)$/i;
        if (!allowedExtensions.test(file.originalname)) {
            return callback(new Error("File type transformation rejected. Extension must be a valid office/document asset structure."), false);
        }
        callback(null, true);
    }
});

// ==========================================
// 9) IN-MEMORY SECURE ASSET META CATALOG
// ==========================================
const documentCatalogRegistry = new Map();

// v4.6.1: every route needs a caller the server can identify (signed-in account or a guest session) and meeting access is checked
// against the server's own record of who may be in that meeting, never against ids the client sends.
const requireActor = (req, res, next) => (req.actor ? next() : res.status(401).json({ error: 'Sign in or join the meeting first.' }));
const cleanMeeting = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const publicDoc = ({ ownerId, scope, meetingId, ...rest }) => rest;
const meetingAssetLinks = new Map(); // Maps meetingId -> Array of documentIds

// Seed mock instance structure data to populate UI tables immediately
const mockDocId = uuidv4();
documentCatalogRegistry.set(mockDocId, {
    documentId: mockDocId,
    fileName: "Thesis_Introductory_Framework.pdf",
    fileUrl: "https://cloud-storage.internal",
    fileSizeBytes: 4182910,
    uploadedBy: "usr_jane_doe",
    uploadedAt: new Date("2026-10-20T10:00:00Z").toISOString()
});
meetingAssetLinks.set("858 9833 3712", [mockDocId]);

// ==========================================
// REST CORE API ROUTING ENDPOINTS
// ==========================================

/**
 * 📤 Endpoint 1: Handle Secure Document Upload Streaming Stream Ingestion
 * Emulates cloud destination processing (e.g. AWS S3/Azure Blob) and registers metadata tags.
 */
router.post('/upload', requireActor, uploadLimiter.single('attachedFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No multi-part binary streaming handle located in multi-part form execution context." });
        }

        // Guests can only ever upload into the meeting their session belongs to; accounts may upload to a meeting they host or
        // joined, or keep the file as a workspace document (no meeting). The uploader id comes from the session, not the form.
        const requested = cleanMeeting(req.body.targetMeetingId);
        const targetMeetingId = req.actor.type === 'guest' ? req.actor.session.meetingId : requested;
        if (requested && req.actor.type === 'guest' && requested !== targetMeetingId) return res.status(403).json({ error: 'You can only add documents to the meeting you joined.' });
        if (targetMeetingId && !req.canAccessMeeting(targetMeetingId)) return res.status(403).json({ error: 'You do not have access to that meeting.' });
        if (targetMeetingId && req.actor.type === 'guest' && !req.actor.session.caps.includes('docs:upload')) return res.status(403).json({ error: 'Not permitted.' });

        // Generate unique structural resource tracker tokens
        const secureDocumentId = uuidv4();
        
        // Mock secure cloud delivery path mapping (Simulation of production CDN path mappings)
        const cloudDestinationUri = `https://cloud-storage.internal/${secureDocumentId}_${req.file.originalname.replace(/\s+/g, '_')}`;

        const metadataEntity = {
            documentId: secureDocumentId,
            fileName: req.file.originalname,
            fileUrl: cloudDestinationUri,
            fileSizeBytes: req.file.size,
            uploadedBy: req.actor.type === 'guest' ? req.actor.session.name : (req.actor.user.displayName || req.actor.user.username || 'member'),
            uploadedAt: new Date().toISOString(),
            ownerId: req.actor.id,
            scope: targetMeetingId ? 'meeting' : 'workspace',
            meetingId: targetMeetingId || null
        };

        // Commit file meta tracking registry entries directly to global collection
        documentCatalogRegistry.set(secureDocumentId, metadataEntity);

        // Conditional Assignment: If uploaded inside an active meeting scope, auto-link it
        if (targetMeetingId) {
            const cleanMeetingId = targetMeetingId;
            if (!meetingAssetLinks.has(cleanMeetingId)) {
                meetingAssetLinks.set(cleanMeetingId, []);
            }
            meetingAssetLinks.get(cleanMeetingId).push(secureDocumentId);
        }

        console.log(`[Cloud Integration Engine]: Asset "${metadataEntity.fileName}" stream committed directly to object bucket storage.`);
        
        return res.status(201).json({
            success: true,
            message: "Asset stream pipeline closed successfully. Storage nodes allocated.",
            document: publicDoc(metadataEntity)
        });

    } catch (err) {
        return res.status(500).json({ error: "Internal Document Upload pipeline failure." });
    }
});

/**
 * 🔗 Endpoint 2: Explicitly Link an Existing Document Asset ID to a Meeting Reference
 */
router.post('/link-to-meeting', requireActor, (req, res) => {
    const { documentId } = req.body;
    const cleanMeetingId = cleanMeeting(req.body.meetingId) || null;

    if (!documentId || !cleanMeetingId) {
        return res.status(400).json({ error: "Missing source documentId or target meeting reference mapping parameter." });
    }

    if (!req.canAccessMeeting(cleanMeetingId)) return res.status(403).json({ error: 'You do not have access to that meeting.' });
    // The caller must own the document (or it must already belong to this meeting). One uniform answer for "missing" and "not yours"
    // so document ids cannot be probed. A document that belongs to one meeting can never be linked into another.
    const doc = documentCatalogRegistry.get(documentId);
    const already = (meetingAssetLinks.get(cleanMeetingId) || []).includes(documentId);
    if (!doc || (!already && doc.ownerId !== req.actor.id) || (doc.scope === 'meeting' && doc.meetingId !== cleanMeetingId)) {
        return res.status(404).json({ error: "Document not found." });
    }

    if (!meetingAssetLinks.has(cleanMeetingId)) {
        meetingAssetLinks.set(cleanMeetingId, []);
    }

    // Guard against injecting duplicate resource links into structural metadata arrays
    if (!meetingAssetLinks.get(cleanMeetingId).includes(documentId)) {
        meetingAssetLinks.get(cleanMeetingId).push(documentId);
    }

    return res.json({
        success: true,
        message: "Resource cross-link established.",
        linkedDocumentId: documentId,
        boundMeetingId: cleanMeetingId
    });
});

/**
 * 🔍 Endpoint 3: Fetch and Resolve All Document Registry References Filtered by Meeting Code
 */
router.get('/meeting/:meetingId', requireActor, (req, res) => {
    const cleanMeetingId = cleanMeeting(req.params.meetingId);
    if (!req.canAccessMeeting(cleanMeetingId)) return res.status(403).json({ error: 'You do not have access to this meeting.' });
    const documentIdArray = meetingAssetLinks.get(cleanMeetingId) || [];

    // Map underlying tracking IDs directly into rich structural response payloads
    const resolvedDocuments = documentIdArray
        .map(id => documentCatalogRegistry.get(id))
        .filter(doc => doc !== undefined)
        .map(publicDoc);

    return res.json({
        meetingId: cleanMeetingId,
        associatedDocumentsCount: resolvedDocuments.length,
        documents: resolvedDocuments
    });
});

// Error handling middleware callback loop for payload verification enforcement
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: "Payload rejected. Target upload object passes maximum allowed limit constraints (25MB)." });
    }
    if (err) {
        return res.status(400).json({ error: "Form request parsing operation error.", warning: err.message });
    }
    next();
});

module.exports = router;