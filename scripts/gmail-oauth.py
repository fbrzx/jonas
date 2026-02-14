"""
Generate a Gmail OAuth token JSON for use with Credentials.from_authorized_user_info().

Usage:
  1. Place your OAuth credentials JSON (the "installed" one from Google Cloud Console)
     in a file called credentials.json next to this script, or pass --credentials <path>.
  2. Run: python3 scripts/gmail-oauth.py
  3. A browser window opens — sign in and grant access.
  4. Copy the printed JSON into your skill's GMAIL_TOKEN_JSON config value.

Requirements:
  pip3 install google-auth google-auth-oauthlib
"""

import argparse
import json
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def main():
    parser = argparse.ArgumentParser(description="Generate Gmail OAuth token JSON")
    parser.add_argument(
        "--credentials",
        default=str(Path(__file__).parent / "credentials.json"),
        help="Path to OAuth client credentials JSON (default: scripts/credentials.json)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8085,
        help="Local port for the OAuth redirect (default: 8085)",
    )
    args = parser.parse_args()

    creds_path = Path(args.credentials)
    if not creds_path.exists():
        print(f"Error: credentials file not found at {creds_path}", file=sys.stderr)
        print(
            "Download it from Google Cloud Console → APIs & Services → Credentials",
            file=sys.stderr,
        )
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
    creds = flow.run_local_server(
        port=args.port, prompt="consent", access_type="offline"
    )

    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes),
    }

    print("\n--- Copy everything below this line ---\n")
    print(json.dumps(token_data, indent=2))
    print("\n--- Copy everything above this line ---")


if __name__ == "__main__":
    main()
