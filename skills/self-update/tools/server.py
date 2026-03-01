import json
import subprocess
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("self-update")

# When running inside Docker with the host repo mounted at /host/jonas,
# we operate on that path. If the mount isn't present (e.g. local dev),
# fall back to the container-local copy.
import os
JONAS_DIR = "/host/jonas" if os.path.isdir("/host/jonas") else "/home/fbrz/jonas"


@mcp.tool()
def check_for_updates() -> str:
    """Check if there are new commits available on the remote GitHub repository."""
    try:
        # Fetch remote without merging
        fetch = subprocess.run(
            ["git", "fetch", "origin", "main"],
            cwd=JONAS_DIR,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if fetch.returncode != 0:
            return json.dumps({"error": f"git fetch failed: {fetch.stderr}"})

        # Compare local HEAD with remote
        status = subprocess.run(
            ["git", "rev-list", "--count", "HEAD..origin/main"],
            cwd=JONAS_DIR,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if status.returncode != 0:
            return json.dumps({"error": f"git rev-list failed: {status.stderr}"})

        behind = int(status.stdout.strip())

        if behind == 0:
            return json.dumps({"up_to_date": True, "commits_behind": 0, "message": "Jonas is up to date."})

        # Get the pending commit messages
        log = subprocess.run(
            ["git", "log", "--oneline", f"HEAD..origin/main"],
            cwd=JONAS_DIR,
            capture_output=True,
            text=True,
            timeout=10,
        )
        pending = log.stdout.strip() if log.returncode == 0 else "(could not retrieve log)"

        return json.dumps({
            "up_to_date": False,
            "commits_behind": behind,
            "pending_commits": pending,
            "message": f"Jonas is {behind} commit(s) behind origin/main.",
        })

    except subprocess.TimeoutExpired:
        return json.dumps({"error": "Command timed out"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def perform_update() -> str:
    """
    Pull latest code from GitHub and trigger a make rebuild.
    WARNING: Jonas will restart and go offline for ~30-60 seconds.
    This is expected — the operator should reconnect after the rebuild completes.
    """
    try:
        # Step 1: git pull
        pull = subprocess.run(
            ["git", "pull", "origin", "main"],
            cwd=JONAS_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if pull.returncode != 0:
            return json.dumps({"error": f"git pull failed: {pull.stderr}", "stdout": pull.stdout})

        pull_output = pull.stdout.strip()

        # Step 2: make rebuild (runs docker compose build + up -d)
        # This is intentionally non-blocking — Jonas will restart mid-way.
        rebuild = subprocess.Popen(
            ["make", "rebuild"],
            cwd=JONAS_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        return json.dumps({
            "success": True,
            "git_pull": pull_output,
            "rebuild_pid": rebuild.pid,
            "message": (
                "git pull succeeded. Rebuild started (PID {pid}). "
                "Jonas will go offline in ~5 seconds and restart within 30-60 seconds. "
                "Please reconnect after the restart."
            ).format(pid=rebuild.pid),
        })

    except subprocess.TimeoutExpired:
        return json.dumps({"error": "git pull timed out"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def get_current_version() -> str:
    """Get the current git commit info for the running Jonas instance."""
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%H|%s|%ai|%an"],
            cwd=JONAS_DIR,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return json.dumps({"error": f"git log failed: {result.stderr}"})

        parts = result.stdout.strip().split("|", 3)
        return json.dumps({
            "commit": parts[0] if len(parts) > 0 else "unknown",
            "message": parts[1] if len(parts) > 1 else "unknown",
            "date": parts[2] if len(parts) > 2 else "unknown",
            "author": parts[3] if len(parts) > 3 else "unknown",
            "working_dir": JONAS_DIR,
        })

    except subprocess.TimeoutExpired:
        return json.dumps({"error": "Command timed out"})
    except Exception as e:
        return json.dumps({"error": str(e)})


if __name__ == "__main__":
    mcp.run(transport="stdio")
