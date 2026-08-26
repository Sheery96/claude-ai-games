(() => {
  'use strict';

  const GRID = 20;                 // 20x20 cells, classic Nokia-ish resolution
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const cell = canvas.width / GRID;

  const scoreEl = document.getElementById('score');
  const hiScoreEl = document.getElementById('highscore');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayMsg = document.getElementById('overlay-msg');

  const LCD_BG = '#c4cfa1';
  const LCD_FG = '#0f380f';

  const STORAGE_KEY = 'snake-nokia-highscore';
  const BASE_SPEED_MS = 160;
  const MIN_SPEED_MS = 70;

  let snake, dir, nextDir, food, score, highScore, speed, timer, running, gameOver;

  function loadHighScore() {
    try {
      return parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function saveHighScore(v) {
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (e) { /* ignore */ }
  }

  function randCell(exclude) {
    let pos;
    do {
      pos = {
        x: Math.floor(Math.random() * GRID),
        y: Math.floor(Math.random() * GRID),
      };
    } while (exclude.some(s => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function reset() {
    const mid = Math.floor(GRID / 2);
    snake = [
      { x: mid - 1, y: mid },
      { x: mid - 2, y: mid },
      { x: mid - 3, y: mid },
    ];
    dir = { x: 1, y: 0 };
    nextDir = dir;
    score = 0;
    speed = BASE_SPEED_MS;
    food = randCell(snake);
    running = false;
    gameOver = false;
    updateScore();
    draw();
    showOverlay('SNAKE', 'Press any key or tap to start');
  }

  function updateScore() {
    scoreEl.textContent = 'SCORE: ' + score;
    hiScoreEl.textContent = 'HI: ' + highScore;
  }

  function showOverlay(title, msg) {
    overlayTitle.textContent = title;
    overlayMsg.textContent = msg;
    overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function start() {
    if (running) return;
    if (gameOver) reset();
    running = true;
    hideOverlay();
    clearInterval(timer);
    timer = setInterval(tick, speed);
  }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(tick, speed);
  }

  function setDirection(x, y) {
    // prevent reversing directly into itself
    if (snake.length > 1 && dir.x === -x && dir.y === -y) return;
    nextDir = { x, y };
    if (!running && !gameOver) start();
  }

  function tick() {
    dir = nextDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    // wall collision = game over (classic Nokia behaviour)
    if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) {
      return endGame();
    }
    // self collision
    if (snake.some(s => s.x === head.x && s.y === head.y)) {
      return endGame();
    }

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += 1;
      if (score > highScore) {
        highScore = score;
        saveHighScore(highScore);
      }
      updateScore();
      food = randCell(snake);
      // speed up slightly, capped
      speed = Math.max(MIN_SPEED_MS, BASE_SPEED_MS - score * 4);
      restartTimer();
    } else {
      snake.pop();
    }

    draw();
  }

  function endGame() {
    running = false;
    gameOver = true;
    clearInterval(timer);
    showOverlay('GAME OVER', 'Score: ' + score + '  |  Tap or press any key to retry');
  }

  function draw() {
    ctx.fillStyle = LCD_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = LCD_FG;
    // food
    ctx.fillRect(food.x * cell + 1, food.y * cell + 1, cell - 2, cell - 2);
    // snake
    snake.forEach((seg, i) => {
      const pad = i === 0 ? 0.5 : 1;
      ctx.fillRect(seg.x * cell + pad, seg.y * cell + pad, cell - pad * 2, cell - pad * 2);
    });
  }

  // --- input ---

  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowUp': case 'w': case 'W': setDirection(0, -1); e.preventDefault(); break;
      case 'ArrowDown': case 's': case 'S': setDirection(0, 1); e.preventDefault(); break;
      case 'ArrowLeft': case 'a': case 'A': setDirection(-1, 0); e.preventDefault(); break;
      case 'ArrowRight': case 'd': case 'D': setDirection(1, 0); e.preventDefault(); break;
      default:
        if (!running) start();
    }
  });

  overlay.addEventListener('click', () => { if (!running) start(); });

  document.getElementById('btn-up').addEventListener('click', () => setDirection(0, -1));
  document.getElementById('btn-down').addEventListener('click', () => setDirection(0, 1));
  document.getElementById('btn-left').addEventListener('click', () => setDirection(-1, 0));
  document.getElementById('btn-right').addEventListener('click', () => setDirection(1, 0));

  // swipe controls on the canvas itself
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) {
      if (!running) start();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      setDirection(dx > 0 ? 1 : -1, 0);
    } else {
      setDirection(0, dy > 0 ? 1 : -1);
    }
    touchStart = null;
  }, { passive: true });

  // --- init ---
  highScore = loadHighScore();
  reset();
})();
