/**
 * StatusUI - Visual feedback overlay for form-filling progress.
 *
 * Renders a fixed-position banner at the bottom of the page
 * showing status text and an optional running timer.
 */
class StatusUI {
  constructor() {
    this.overlay = null;
    this.statusTextElement = null;
    this.timerInterval = null;
    this.hideTimeout = null;
    this._init();
  }

  /* ---- private ---- */

  _init() {
    const existing = document.getElementById('form-filler-overlay');
    if (existing) {
      this.overlay = existing;
      this.statusTextElement = this.overlay.querySelector('span');
      if (!this.statusTextElement) {
        this.statusTextElement = document.createElement('span');
        this.overlay.appendChild(this.statusTextElement);
      }
      return;
    }

    this.overlay = document.createElement('div');
    this.overlay.id = 'form-filler-overlay';
    Object.assign(this.overlay.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '10000',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      color: 'white',
      padding: '15px 25px',
      borderRadius: '10px',
      boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      gap: '15px',
      fontFamily: 'sans-serif',
      fontSize: '16px',
      transition: 'opacity 0.5s, bottom 0.5s',
      opacity: '1',
    });

    this.statusTextElement = document.createElement('span');
    this.overlay.appendChild(this.statusTextElement);
    document.body.appendChild(this.overlay);
  }

  _stopTimers() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  /* ---- public ---- */

  /** Show a static status message (stops any running timer). */
  update(message) {
    this._stopTimers();
    if (!this.overlay || this.overlay.style.opacity === '0') {
      this._init();
    }
    if (this.statusTextElement) {
      this.statusTextElement.textContent = message;
    }
  }

  /** Show a message with a running seconds counter. */
  startTimer(baseMessage) {
    this._stopTimers();
    const startTime = Date.now();
    const tick = () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (this.statusTextElement) {
        this.statusTextElement.textContent = `${baseMessage} (${elapsed}s)`;
      }
    };
    tick();
    this.timerInterval = setInterval(tick, 1000);
  }

  /** Stop the running timer without removing the overlay. */
  stopTimer() {
    this._stopTimers();
  }

  /** Fade out and remove the overlay from the DOM. */
  remove() {
    this._stopTimers();
    if (this.overlay) {
      this.overlay.style.opacity = '0';
      this.overlay.style.bottom = '-100px';
      setTimeout(() => {
        if (this.overlay) {
          this.overlay.remove();
          this.overlay = null;
        }
      }, 500);
    }
  }
}
