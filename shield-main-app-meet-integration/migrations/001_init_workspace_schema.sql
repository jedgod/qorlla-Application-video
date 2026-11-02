-- Zoom Core Workspace Engine Schema Initialization
-- Architecture Target Mapping: Layers 1, 2, 6, 7, and 9 (Data Persistence Models)

BEGIN;

-- Enable standard multi-node cross-platform UUID support engines
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- btree_gist lets the meetings exclusion constraint combine UUID equality with time ranges
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================
-- 1) SYSTEM USER ACCESS ACCOUNT REGISTRY
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role_type VARCHAR(50) NOT NULL DEFAULT 'participant', -- 'host', 'participant', 'admin'
    timezone VARCHAR(100) NOT NULL DEFAULT 'GMT-4:00',
    language_code VARCHAR(10) NOT NULL DEFAULT 'en',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2) SCHEDULING & OVERLAP PREVENTION MATRIX
-- ==========================================
CREATE TABLE IF NOT EXISTS meetings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_numeric_id VARCHAR(50) UNIQUE NOT NULL, -- Standardized sequence format: '858 9833 3712'
    topic VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes INT NOT NULL,
    buffer_minutes INT NOT NULL DEFAULT 15,
    blocked_until TIMESTAMP WITH TIME ZONE NOT NULL,
    host_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    room_status VARCHAR(50) NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'active', 'completed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT check_duration_positive CHECK (duration_minutes > 0),

    -- blocked_until = start_time + duration + buffer. It is stored (not computed) because
    -- timestamptz + interval is not IMMUTABLE and so cannot appear in an index expression.
    CONSTRAINT check_blocked_window CHECK (
        blocked_until = start_time + make_interval(mins => duration_minutes + buffer_minutes)
    ),

    -- Prevent overlapping bookings (including the buffer) on a single host's calendar
    CONSTRAINT meetings_no_host_overlap EXCLUDE USING gist (
        host_id WITH =,
        tstzrange(start_time, blocked_until) WITH &&
    )
);

-- Indexing engine for query lookups targeting active timelines
CREATE INDEX IF NOT EXISTS idx_meetings_timeline ON meetings(start_time, room_status);

-- ==========================================
-- 3) REALTIME STREAM MESSAGING REGISTRY
-- ==========================================
CREATE TABLE IF NOT EXISTS meeting_chats (
    id BIGSERIAL PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_text TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    dispatched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_meeting_stream ON meeting_chats(meeting_id, dispatched_at);

-- ==========================================
-- 4) CLOUD STORAGE MEMORY ELEMENT ASSETS
-- ==========================================
CREATE TABLE IF NOT EXISTS document_registry (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name VARCHAR(255) NOT NULL,
    cloud_url TEXT NOT NULL,
    file_type VARCHAR(20) NOT NULL, -- 'pdf', 'docx', 'pptx', etc.
    file_size_bytes BIGINT NOT NULL,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT check_max_file_size CHECK (file_size_bytes <= 26214400) -- Enforce Layer 2 constraint: 25MB Maximum Ceiling
);

-- Cross-reference bridging mapping architecture linking files directly to specific meeting records
CREATE TABLE IF NOT EXISTS meeting_documents (
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES document_registry(id) ON DELETE CASCADE,
    PRIMARY KEY (meeting_id, document_id)
);

-- ==========================================
-- 5) TELEMETRY BUFFERS: PERSISTENT SCRATCHPADS
-- ==========================================
CREATE TABLE IF NOT EXISTS meeting_notes_scratchpad (
    meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    raw_text_payload TEXT,
    last_saved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 6) POST-MEETING TRANSCRIPTS & AI SUMMARIES
-- ==========================================
CREATE TABLE IF NOT EXISTS post_meeting_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id UUID UNIQUE NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    recording_stream_url TEXT,
    ai_abstract TEXT,
    ai_action_items JSONB NOT NULL DEFAULT '[]'::jsonb, -- Structured bullet arrays parsed dynamically
    sentiment_score VARCHAR(50),
    compiled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- AUTOMATED MODIFICATION TRIGGERS
-- ==========================================
CREATE OR REPLACE FUNCTION update_modified_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_modtime BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_modified_timestamp_column();

COMMIT;