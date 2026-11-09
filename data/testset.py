"""The test set: videos from anywhere (stock, TikTok, YouTube, Instagram, your phone), one command each.

    uv run --project data python -m data.testset list
    uv run --project data python -m data.testset add <url or file> --id bailar-03 --categoria bailar [--licencia "..."]
    uv run --project data python -m data.testset download [--only lavar-01,bailar-01]
    uv run --project data python -m data.testset extract  [--only ...]      # PoseClip of each video (data.extract)
    uv run --project data python -m data.testset quality --save <label>     # quality card of each clip (data.quality)

Tridi has to work with whatever video people have: a handheld phone, a webcam, a TikTok with five
people dancing. So the test set is not a studio session; it is a list of real videos per skill
(data/set-de-prueba/manifest.csv, versioned) and the numbers each capture version gets on them
(quality.csv). The videos and their clips stay on this Mac, in data/set-de-prueba/ (gitignored,
never in git, never uploaded).

Licenses (the manifest's "licencia" column): Pexels, Mixkit and Pixabay allow free use, commercial
included. A TikTok, YouTube or Instagram video belongs to whoever posted it: fine for testing on this
Mac, not as data we sell. Every download goes through yt-dlp, the same tool as Juan's song skill.
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent / "set-de-prueba"
MANIFEST = HERE / "manifest.csv"
HOME = HERE
VIDEOS = HOME / "videos"
CLIPS = HOME / "clips"
FIELDS = ["id", "categoria", "fuente", "url", "licencia", "estado", "notas"]


def rows() -> list[dict]:
    with open(MANIFEST) as f:
        return list(csv.DictReader(f))


def save(all_rows: list[dict]) -> None:
    with open(MANIFEST, "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        w.writerows(all_rows)


def video_of(row: dict) -> Path | None:
    found = sorted(VIDEOS.glob(f"{row['id']}.*"))
    return found[0] if found else None


def pick(only: str | None) -> list[dict]:
    wanted = set(only.split(",")) if only else None
    return [r for r in rows() if wanted is None or r["id"] in wanted]


def download(row: dict) -> Path | None:
    VIDEOS.mkdir(parents=True, exist_ok=True)
    if (have := video_of(row)) is not None:
        return have
    url = row["url"]
    if Path(url).expanduser().exists():  # a local file: copy it in, keep the original where it is
        src = Path(url).expanduser()
        dst = VIDEOS / f"{row['id']}{src.suffix.lower()}"
        dst.write_bytes(src.read_bytes())
        return dst
    # Everything through yt-dlp, 1080p at most (the capture does not use more). Pexels too: its
    # /download/video/<id>/ link answers 403 to curl (bot protection, 2026-11-03), while yt-dlp's
    # generic extractor finds the page's own mp4 on videos.pexels.com.
    template = str(VIDEOS / f"{row['id']}.%(ext)s")
    done = subprocess.run(["yt-dlp", "-q", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4",
                           "-o", template, url])
    return video_of(row) if done.returncode == 0 else None


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m data.testset", description=__doc__.split("\n")[0])
    p.add_argument("command", choices=["list", "add", "download", "extract", "quality"])
    p.add_argument("source", nargs="?", help="add: the video's URL or a file on this Mac")
    p.add_argument("--id")
    p.add_argument("--categoria", default="otro")
    p.add_argument("--licencia", default="")
    p.add_argument("--notas", default="")
    p.add_argument("--only", help="comma-separated ids")
    p.add_argument("--save", help="quality: label of this capture version")
    args = p.parse_args()

    if args.command == "list":
        for r in rows():
            have = "✓" if video_of(r) else "·"
            print(f"{have} {r['id']:18s} {r['categoria']:14s} {r['estado']:10s} {r['url']}")
        return
    if args.command == "add":
        if not args.source or not args.id:
            sys.exit("add needs the URL (or file) and --id")
        source = "local" if Path(args.source).expanduser().exists() else next(
            (s for s in ("tiktok", "youtube", "youtu.be", "instagram", "pexels", "mixkit", "pixabay") if s in args.source), "web")
        license_ = args.licencia or ("propio" if source == "local" else
                                     "Pexels (uso libre, también comercial)" if source == "pexels" else
                                     "solo pruebas internas (de quien lo publicó)")
        all_rows = [r for r in rows() if r["id"] != args.id]
        all_rows.append({"id": args.id, "categoria": args.categoria, "fuente": source.replace("youtu.be", "youtube"),
                         "url": args.source, "licencia": license_, "estado": "candidato", "notas": args.notas})
        save(all_rows)
        print(f"added {args.id}")
        return
    if args.command == "download":
        for r in pick(args.only):
            path = download(r)
            print(f"{'✓' if path else '✗'} {r['id']}: {path or 'could not download'}")
        return
    if args.command == "extract":
        CLIPS.mkdir(parents=True, exist_ok=True)
        for r in pick(args.only):
            video = video_of(r)
            if video is None:
                print(f"· {r['id']}: not downloaded")
                continue
            # With several people, data.track picks one on its own (_pick_auto); to choose another,
            # run data.extract by hand with --click x,y on that person.
            subprocess.run([sys.executable, "-m", "data.extract", str(video), "--out", str(CLIPS), "--id", f"clip_{r['id']}"])
        return
    if args.command == "quality":
        clips = sorted(CLIPS.glob("clip_*.json"))
        if args.only:
            clips = [c for c in clips if c.stem.removeprefix("clip_") in args.only.split(",")]
        cmd = [sys.executable, "-m", "data.quality", *map(str, clips)]
        subprocess.run(cmd + (["--save", args.save] if args.save else []))


if __name__ == "__main__":
    main()
