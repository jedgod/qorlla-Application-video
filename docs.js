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
router.post('/upload', uploadLimiter.single('attachedFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No multi-part binary streaming handle located in multi-part form execution context." });
        }

        const { userId, targetMeetingId } = req.body;

        // Generate unique structural resource tracker tokens
        const secureDocumentId = uuidv4();
        
        // Mock secure cloud delivery path mapping (Simulation of production CDN path mappings)
        const cloudDestinationUri = `https://cloud-storage.internal/${secureDocumentId}_${req.file.originalname.replace(/\s+/g, '_')}`;

        const metadataEntity = {
            documentId: secureDocumentId,
            fileName: req.file.originalname,
            fileUrl: cloudDestinationUri,
            fileSizeBytes: req.file.size,
            uploadedBy: userId || 'anonymous_uploader',
            uploadedAt: new Date().toISOString()
        };

        // Commit file meta tracking registry entries directly to global collection
        documentCatalogRegistry.set(secureDocumentId, metadataEntity);

        // Conditional Assignment: If uploaded inside an active meeting scope, auto-link it
        if (targetMeetingId) {
            const cleanMeetingId = targetMeetingId.replace(/\s+/g, ' ');
            if (!meetingAssetLinks.has(cleanMeetingId)) {
                meetingAssetLinks.set(cleanMeetingId, []);
            }
            meetingAssetLinks.get(cleanMeetingId).push(secureDocumentId);
        }

        console.log(`[Cloud Integration Engine]: Asset "${metadataEntity.fileName}" stream committed directly to object bucket storage.`);
        
        return res.status(201).json({
            success: true,
            message: "Asset stream pipeline closed successfully. Storage nodes allocated.",
            document: metadataEntity
        });

    } catch (err) {
        return res.status(500).json({ error: "Internal Document Upload pipeline failure.", details: err.message });
    }
});

/**
 * 🔗 Endpoint 2: Explicitly Link an Existing Document Asset ID to a Meeting Reference
 */
router.post('/link-to-meeting', (req, res) => {
    const { documentId, meetingId } = req.body;
    const cleanMeetingId = meetingId ? meetingId.replace(/\s+/g, ' ') : null;

    if (!documentId || !cleanMeetingId) {
        return res.status(400).json({ error: "Missing source documentId or target meeting reference mapping parameter." });
    }

    if (!documentCatalogRegistry.has(documentId)) {
        return res.status(404).json({ error: "Target catalog file mapping block entry not found within repository registry." });
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
router.get('/meeting/:meetingId', (req, res) => {
    const cleanMeetingId = req.params.meetingId.replace(/\s+/g, ' ');
    const documentIdArray = meetingAssetLinks.get(cleanMeetingId) || [];

    // Map underlying tracking IDs directly into rich structural response payloads
    const resolvedDocuments = documentIdArray
        .map(id => documentCatalogRegistry.get(id))
        .filter(doc => doc !== undefined);

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