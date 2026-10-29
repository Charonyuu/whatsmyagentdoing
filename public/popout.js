// Document PiP uses a separate page so its animation clock keeps running when
// the opener tab is hidden (the iframe approach from wanting82's PR #3).
// Older browsers can use their video PiP controls on a local canvas stream.
(() => {
  'use strict';

  class OfficePopout {
    constructor({ preferences, office, text, changed }) {
      this.preferences = preferences;
      this.office = office;
      this.text = text;
      this.changed = changed;
      this.win = null;
      this.busy = false;
      this.stream = null;
      this.panel = document.getElementById('pipPreview');
      this.video = document.getElementById('pipVideo');
      this.error = document.getElementById('pipError');
      this.videoButton = document.getElementById('videoPipBtn');
      document.getElementById('pipBtn').addEventListener('click', () => this.toggle());
      document.getElementById('closePreview').addEventListener('click', () => this.stopPreview());
      this.videoButton.addEventListener('click', () => this.openVideo().catch(() => this.fail()));
      this.video.addEventListener('leavepictureinpicture', () => this.stopPreview());
      window.addEventListener('pagehide', () => this.close());
    }

    get documentSupported() {
      return !this.documentBroken && window.top === window && typeof window.documentPictureInPicture?.requestWindow === 'function';
    }

    get videoSupported() {
      return typeof HTMLCanvasElement.prototype.captureStream === 'function';
    }

    sync(compact, view) {
      const button = document.getElementById('pipBtn');
      button.hidden = compact || !(this.documentSupported || (this.videoSupported && view === 'office'));
      button.disabled = this.busy;
      button.textContent = this.win ? this.text('pipClose') : this.stream ? this.text('pipStop') : this.text('pip');
      button.setAttribute('aria-pressed', String(!!(this.win || this.stream)));
      this.videoButton.hidden = !this.canOpenVideo();
      if (this.error.textContent) this.error.textContent = this.text('pipFailed');
      if (view !== 'office' && this.stream) this.stopPreview();
    }

    fail() {
      this.error.textContent = this.text('pipFailed');
      this.error.hidden = false;
    }

    async toggle() {
      if (this.busy) return;
      this.error.textContent = '';
      this.error.hidden = true;
      if (this.win) { this.close(); return; }
      if (this.stream) { this.stopPreview(); return; }
      this.busy = true;
      this.changed();
      try {
        if (this.documentSupported) {
          try {
            await this.openDocument();
          } catch (e) {
            // Some embedded browsers (app web views) expose the API but can't
            // open a window ("no window"). Use the video pop-out there instead,
            // and skip the window from now on.
            if (e.name !== 'InvalidStateError' || !this.videoSupported) throw e;
            this.documentBroken = true;
            await this.startPreview();
          }
        } else await this.startPreview();
      } catch (e) {
        console.warn('Could not open picture-in-picture:', e);
        this.close();
        if (e.name !== 'AbortError') this.fail();
      } finally {
        this.busy = false;
        this.changed();
      }
    }

    async openDocument() {
      const win = await window.documentPictureInPicture.requestWindow({ width: 480, height: 400 });
      if (win.closed) return;
      this.win = win;
      win.addEventListener('pagehide', () => {
        if (this.win !== win) return;
        this.win = null;
        this.changed();
      }, { once: true });
      const d = win.document;
      d.title = this.text('title');
      const style = d.createElement('style');
      style.textContent = 'html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
      d.head.append(style);
      const frame = d.createElement('iframe');
      frame.title = this.text('title');
      const url = new URL('/', location.href);
      url.searchParams.set('pip', '1');
      // Carry the current settings even if storage is unavailable. The page
      // validates these preferences before using them.
      url.searchParams.set('prefs', JSON.stringify(this.preferences()));
      frame.src = url.href;
      d.body.append(frame);
    }

    canOpenVideo() {
      return (document.pictureInPictureEnabled && typeof this.video.requestPictureInPicture === 'function') ||
        (typeof this.video.webkitSupportsPresentationMode === 'function' && this.video.webkitSupportsPresentationMode('picture-in-picture'));
    }

    async openVideo() {
      if (document.pictureInPictureEnabled && this.video.requestPictureInPicture) {
        await this.video.requestPictureInPicture();
      } else if (this.video.webkitSetPresentationMode) {
        this.video.webkitSetPresentationMode('picture-in-picture');
      }
    }

    async startPreview() {
      this.captureCanvas = document.createElement('canvas');
      this.captureCanvas.width = 960;
      this.captureCanvas.height = 540;
      this.captureContext = this.captureCanvas.getContext('2d');
      this.stream = this.captureCanvas.captureStream(15);
      this.video.srcObject = this.stream;
      this.panel.hidden = false;
      // A background tab can stop requestAnimationFrame. Keep the preview
      // current at a lower rate; browsers may throttle this timer further.
      this.timer = setInterval(() => {
        if (document.hidden) this.office()?.frame(performance.now());
      }, 250);
      this.office()?.frame(performance.now());
      await this.video.play();
      if (!this.stream) return;
      if (this.canOpenVideo()) {
        // If transient activation expired, the preview has a fresh-click
        // button. Firefox versions without the API expose their own controls.
        try { await this.openVideo(); } catch { /* use the preview controls */ }
      }
    }

    drawPreview(office) {
      if (!this.stream || !office.canvas.width || !office.canvas.height) return;
      const c = this.captureContext;
      const w = this.captureCanvas.width, h = this.captureCanvas.height;
      c.fillStyle = office.pal.dark ? '#1e1e1c' : '#fff';
      c.fillRect(0, 0, w, h);
      const scale = Math.min(w / office.canvas.width, h / office.canvas.height);
      const dw = office.canvas.width * scale, dh = office.canvas.height * scale;
      const x = (w - dw) / 2, y = (h - dh) / 2;
      if (office.gl) c.drawImage(office.gl.domElement, x, y, dw, dh);
      c.drawImage(office.canvas, x, y, dw, dh);
    }

    stopPreview() {
      if (!this.stream) return;
      if (document.pictureInPictureElement === this.video) document.exitPictureInPicture().catch(() => {});
      if (this.video.webkitPresentationMode === 'picture-in-picture') this.video.webkitSetPresentationMode('inline');
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      clearInterval(this.timer);
      this.video.pause();
      this.video.srcObject = null;
      this.captureCanvas = this.captureContext = null;
      this.panel.hidden = true;
      this.changed();
    }

    close() {
      const win = this.win;
      this.win = null;
      if (win && !win.closed) win.close();
      this.stopPreview();
      this.changed();
    }
  }

  window.OfficePopout = OfficePopout;
})();
