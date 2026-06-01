# 雲初馥 - 本地 ASR 服务 (faster-whisper)
#
# 启动: python asr_server.py
# 端口: 3211
# 接口: POST /asr  { "audio_path": "/path/to/audio.mp3" }
# 返回: { "transcript": "转写文本", "success": true }

import sys
import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

# Lazy import - faster-whisper takes a while to load
model = None

def get_model():
    global model
    if model is None:
        from faster_whisper import WhisperModel
        print("[ASR] Loading faster-whisper model (large-v3)...")
        # Try GPU first, fallback to CPU
        try:
            model = WhisperModel("large-v3", device="cuda", compute_type="float16")
            print("[ASR] GPU mode (CUDA float16)")
        except Exception as e:
            print(f"[ASR] GPU not available: {e}, falling back to CPU")
            model = WhisperModel("large-v3", device="cpu", compute_type="int8")
            print("[ASR] CPU mode (int8)")
    return model


class ASRHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/asr':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            try:
                data = json.loads(body)
                audio_path = data.get('audio_path', '')
                
                if not audio_path or not os.path.exists(audio_path):
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "音频文件不存在", "success": False}).encode())
                    return
                
                print(f"[ASR] Transcribing: {audio_path}")
                
                m = get_model()
                segments, info = m.transcribe(
                    audio_path,
                    language="zh",
                    beam_size=5,
                    vad_filter=True,
                    vad_parameters=dict(
                        min_silence_duration_ms=500,
                        speech_pad_ms=200
                    )
                )
                
                transcript = "".join(seg.text for seg in segments).strip()
                print(f"[ASR] Done: {len(transcript)} chars, {info.duration:.1f}s audio")
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "transcript": transcript,
                    "duration": info.duration,
                    "language": info.language,
                    "success": True
                }).encode())
                
            except Exception as e:
                print(f"[ASR] Error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e), "success": False}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def log_message(self, format, *args):
        pass  # Suppress default logging


if __name__ == '__main__':
    port = 3211
    server = HTTPServer(('127.0.0.1', port), ASRHandler)
    print(f"[ASR] Local ASR server running on http://localhost:{port}")
    print(f"[ASR] POST /asr  {{ 'audio_path': '/path/to/audio.mp3' }}")
    print(f"[ASR] Model will load on first request (may take ~30s)")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ASR] Server stopped")
        server.server_close()
