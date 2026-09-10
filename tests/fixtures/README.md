# Media fixtures

Synthetic fixtures created for Hyena; no third-party media. Production does not use FFmpeg or containers. FFmpeg was used offline once to make these small test inputs:

```sh
ffmpeg -f lavfi -i color=c=green:s=32x32:r=10 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart short.mp4
ffmpeg -f lavfi -i color=c=green:s=32x32:r=10 -t 60 -c:v libx264 -pix_fmt yuv420p -movflags +faststart sixty-seconds.mp4
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=22050 -t 1 -c:a libmp3lame -b:a 32k short.mp3
```

The tests parse real MP4/MP3 bytes through ranged reads from local R2. Cloudflare Images and Media transformations use explicit test providers. Those providers test orchestration, failure recovery, and R2 persistence; they do not establish conversion quality or live availability. The image/poster stub returns a tiny PNG, not an actual WebP/JPEG transform. Live provider validation is a release gate.
