"""Private, in-memory speech recognition. No third-party inference API."""
import io, os, hmac, tempfile, subprocess
from fastapi import FastAPI, Header, HTTPException, Request
from faster_whisper import WhisperModel

TOKEN = os.environ.get('STT_INTERNAL_TOKEN', '')
if len(TOKEN) < 32:
    raise RuntimeError('STT_INTERNAL_TOKEN must be at least 32 characters')
MODEL = os.environ.get('STT_MODEL', 'small')
DEVICE = os.environ.get('STT_DEVICE', 'cpu')
COMPUTE = os.environ.get('STT_COMPUTE_TYPE', 'int8')
MAX_BYTES = int(os.environ.get('STT_MAX_BYTES', '2000000'))
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, local_files_only=True)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.get('/health')
def health():
    return {'status':'ready','model':MODEL}

@app.post('/internal/transcribe')
async def transcribe(request: Request, x_internal_token: str = Header(default=''), x_language: str = Header(default='en')):
    if not hmac.compare_digest(x_internal_token, TOKEN):
        raise HTTPException(401, 'unauthorized')
    if not x_language.isalpha() or len(x_language) not in (2,3):
        raise HTTPException(400, 'invalid_language')
    if int(request.headers.get('content-length','0')) > MAX_BYTES:
        raise HTTPException(413, 'too_large')
    audio = await request.body()
    if not audio or len(audio) > MAX_BYTES:
        raise HTTPException(413, 'invalid_audio_size')
    # ffmpeg reads from stdin and emits mono 16kHz PCM; no files are persisted.
    try:
        result = subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-i','pipe:0','-ac','1','-ar','16000','-f','wav','pipe:1'], input=audio, capture_output=True, timeout=20, check=True)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        raise HTTPException(422, 'audio_decode_failed')
    if len(result.stdout) > 16000*2*20+128:
        raise HTTPException(413, 'audio_duration_exceeded')
    import soundfile as sf
    import numpy as np
    waveform, sr = sf.read(io.BytesIO(result.stdout), dtype='float32')
    if sr != 16000 or waveform.ndim != 1:
        raise HTTPException(422, 'invalid_audio')
    segments, info = model.transcribe(waveform, language=x_language, vad_filter=True, beam_size=3)
    return {'segments':[{'startMs':int(s.start*1000),'endMs':int(s.end*1000),'text':s.text.strip()} for s in segments if s.text.strip()]}
