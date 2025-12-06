const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const NodeID3 = require('node-id3');
const https = require('https');

ffmpeg.setFfmpegPath(ffmpegPath);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 550,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    resizable: false
  });

  mainWindow.loadFile('index.html');

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Download thumbnail
async function downloadThumbnail(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => { });
      reject(err);
    });
  });
}

// Handle download request
ipcMain.on('start-download', async (event, { url, format }) => {
  let tempVideoPath = null;
  let tempAudioPath = null;
  let thumbnailPath = null;

  try {
    event.reply('download-status', 'Fetching video information...');

    // Get video info
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      preferFreeFormats: true
    });

    const title = info.title.replace(/[^\w\s-]/gi, '').trim();
    const artist = info.uploader || 'Unknown Artist';
    const thumbnail = info.thumbnail;

    // Select save location
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${title}.${format}`,
      filters: [
        { name: format.toUpperCase(), extensions: [format] }
      ]
    });

    if (!filePath) {
      event.reply('download-cancelled');
      return;
    }

    const tempDir = app.getPath('temp');
    tempVideoPath = null; // Not used for MP4 anymore
    tempAudioPath = path.join(tempDir, `temp_audio_${Date.now()}.m4a`);
    thumbnailPath = path.join(tempDir, `thumbnail_${Date.now()}.jpg`);

    if (format === 'mp4') {
      // Download MP4 (video + audio)
      event.reply('download-status', 'Downloading video...');

      // Use a simpler output format without template
      const simpleOutputPath = filePath;

      const ytdlpProcess = ytdlp.exec(url, {
        output: simpleOutputPath,
        format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: ffmpegPath
      });

      // Parse progress from stdout
      ytdlpProcess.stdout.on('data', (data) => {
        const output = data.toString();
        // Match pattern like "[download] 28.9% of 881.15KiB"
        const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
        if (progressMatch) {
          const percent = Math.round(parseFloat(progressMatch[1]));
          event.reply('download-progress', percent);
        }
      });

      await ytdlpProcess;

      event.reply('download-status', 'Processing video...');
      event.reply('download-complete', filePath);

    } else if (format === 'mp3') {
      // Download MP3 (audio only with metadata)
      event.reply('download-status', 'Downloading audio...');

      await ytdlp(url, {
        output: tempAudioPath,
        format: 'bestaudio[ext=m4a]/bestaudio',
        extractAudio: true,
        audioFormat: 'm4a',
        ffmpegLocation: ffmpegPath
      });

      // Download thumbnail
      event.reply('download-status', 'Downloading cover art...');
      try {
        await downloadThumbnail(thumbnail, thumbnailPath);
      } catch (err) {
        console.log('Could not download thumbnail:', err.message);
      }

      event.reply('download-status', 'Converting to MP3 and adding metadata...');

      // Convert to MP3 with ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(tempAudioPath)
          .toFormat('mp3')
          .audioBitrate('320k')
          .on('progress', (progress) => {
            if (progress.percent) {
              event.reply('download-progress', Math.round(progress.percent));
            }
          })
          .on('end', resolve)
          .on('error', reject)
          .save(filePath);
      });

      // Add metadata and cover art
      event.reply('download-status', 'Adding metadata and cover art...');

      const tags = {
        title: info.title,
        artist: artist,
        album: info.album || 'YouTube Download',
        year: new Date(info.upload_date || Date.now()).getFullYear().toString(),
        comment: {
          language: 'eng',
          text: `Downloaded from: ${url}`
        }
      };

      // Add cover art if thumbnail was downloaded
      if (fs.existsSync(thumbnailPath)) {
        tags.image = {
          mime: 'image/jpeg',
          type: {
            id: 3,
            name: 'front cover'
          },
          description: 'Cover',
          imageBuffer: fs.readFileSync(thumbnailPath)
        };
      }

      const success = NodeID3.write(tags, filePath);

      if (!success) {
        console.log('Warning: Could not write all metadata');
      }

      event.reply('download-complete', filePath);
    }

  } catch (error) {
    console.error('Download error:', error);

    // Provide user-friendly error messages
    let userMessage = 'An error occurred during download';

    if (error.message && error.message.includes('Unsupported URL')) {
      userMessage = 'Invalid YouTube URL. Please check the link and try again.';
    } else if (error.message && error.message.includes('Video unavailable')) {
      userMessage = 'This video is unavailable or private.';
    } else if (error.message && error.message.includes('Private video')) {
      userMessage = 'This video is private and cannot be downloaded.';
    } else if (error.message && (error.message.includes('network') || error.message.includes('timeout'))) {
      userMessage = 'Network error. Please check your connection and try again.';
    } else if (error.message && error.message.includes('Sign in to confirm')) {
      userMessage = 'Age-restricted video. Unable to download without authentication.';
    }

    event.reply('download-error', userMessage);
  } finally {
    // Cleanup temp files
    [tempAudioPath, thumbnailPath].forEach(file => {
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (err) {
          console.log('Could not delete temp file:', file);
        }
      }
    });
  }
});
