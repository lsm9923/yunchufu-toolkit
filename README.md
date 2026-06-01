# Yunchufu Toolkit - AI-Powered Content Processing Platform

A local multi-functional content processing platform integrating AI API proxy, content scraping, audio/video transcription, and batch downloading.

[English](#features) | [中文](#功能介绍)

## Features

- **Multi-Platform Content Scraping**: Douyin, Xiaohongshu (Little Red Book), WeChat Video
- **AI-Powered Analysis**: Content extraction, analysis, and report generation via OpenAI-compatible APIs
- **Audio/Video Transcription**: Local ASR (Automatic Speech Recognition) support
- **Batch Download**: Automated Douyin video batch downloading with progress tracking
- **Cross-Platform**: Works on Windows and macOS

## Tech Stack

- **Backend**: Node.js native HTTP server (zero dependencies)
- **Frontend**: Single-page application with responsive card-based UI
- **Python**: ASR service and Douyin batch download tool

## Quick Start

```bash
# Clone the repository
git clone https://github.com/lsm9923/yunchufu-toolkit.git
cd yunchufu-toolkit

# Start the main server
node server.js
# Open http://localhost:3210

# (Optional) Start ASR service for audio/video transcription
python asr_server.py   # Windows
python3 asr_server.py  # macOS
```

## Module Overview

| Module | Description | API Endpoint |
|--------|-------------|--------------|
| Content Extract | Parse links and extract content | `/api/proxy` |
| Content Analysis | AI-powered content analysis | `/api/fetch-article` |
| Xiaohongshu | Scrape notes and download videos | `/api/fetch-xhs` |
| Douyin | Video info + batch download | `/api/fetch-douyin`, `/api/douyin-batch-download` |
| WeChat Video | Scrape video content | `/api/fetch-sph` |
| File Processing | Upload, transcribe, extract text | `/api/upload-file` |

## Configuration

Configure your AI API in the Settings page:

- **API URL**: Any OpenAI-compatible endpoint
- **API Key**: Your API key
- **Model**: Model name (default: `mimo-v2.5-pro`)
- **Temperature**: Generation temperature (default: `0.1`)

## Dependencies

### Node.js
Built with Node.js native modules only - no `npm install` required for the main server.

### Python (for Douyin batch download)
```bash
cd douyin_download
pip install -r requirements.txt
```

## Project Structure

```
├── server.js              # Node.js main server (API proxy + static files)
├── yunchufu.html          # Frontend SPA
├── a_bogus.js             # Douyin signature algorithm
├── asr_server.py          # ASR speech recognition service
├── guide.html             # User guide
├── logo.png               # Project logo
└── douyin_download/       # Douyin batch download tool (Python)
    ├── batch_download.py  # Non-interactive entry point
    ├── run.py             # Interactive CLI entry point
    ├── requirements.txt
    └── src/
        ├── config/        # Settings, Cookie, Account classes
        ├── download/      # List fetching, work parsing, download logic
        ├── encrypt_params/ # a_bogus signature, msToken
        └── tool/          # Utility functions
```

## Why This Project?

In the Chinese content creation ecosystem, creators often need to:

1. **Monitor competitor content** across multiple platforms (Douyin, Xiaohongshu, WeChat)
2. **Analyze trending topics** and content strategies
3. **Archive their own content** with backup downloads
4. **Transcribe video/audio** for content repurposing

This toolkit provides a unified, local-first solution that respects user privacy (no cloud dependencies for core features) and works across all major Chinese social platforms.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Contact

- GitHub: [@lsm9923](https://github.com/lsm9923)
