# Python Backend

This folder now includes a Python version of the API server (`server.py`) that mirrors the existing Node routes.

## Run locally

```bash
cd backend
pip install -r requirements.txt
python server.py
```

The server uses `PORT` (defaults to `3000`) and expects:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `UPLOAD_PASS`
- `RESEND_API_KEY`

## Deploy (Python)

Use a Python runtime and set the start command to:

```bash
gunicorn server:app --bind 0.0.0.0:$PORT
```
