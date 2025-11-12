const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const port = process.env.PORT || 3000;

const app = next({ dev });
const handler = app.getRequestHandler();

let currentGame = null;
let hostDisconnectTimeout = null; // To handle stale games
const GAME_ROOM = 'quiz-game-room';
const HOST_RECONNECT_WINDOW = 300000; // 5 minutes in milliseconds

app.prepare().then(() => {
  const httpServer = createServer(handler);

  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  console.log('Socket.IO server initialized.');

  // --- Game Management Functions ---

  const cleanupGame = () => {
    if (currentGame && !currentGame.hostSocketId) {
      console.log(`Game timed out due to host inactivity. Cleaning up.`);
      io.to(GAME_ROOM).emit('game:ended', 'Game ended due to host inactivity.');
      currentGame = null;
      hostDisconnectTimeout = null;
    }
  };

  const getPublicGameState = () => {
    if (!currentGame) return null;

    // Only hide correct answers during the QUESTION phase
    const isQuestionState = currentGame.state === 'QUESTION';
    
    const publicQuiz = {
      ...currentGame.quiz,
      questions: currentGame.quiz.questions.map(q => ({
        ...q,
        // Strip out the isCorrect flag for players during the question
        options: isQuestionState
          ? q.options.map(({ text }) => ({ text }))
          : q.options,
      })),
    };

    return {
      ...currentGame,
      quiz: publicQuiz,
      players: Array.from(currentGame.players.values()),
    };
  };

  const broadcastGameState = () => {
    io.to(GAME_ROOM).emit('game:update', getPublicGameState());
  };
  
  // --- Socket.IO Connection Logic ---

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.join(GAME_ROOM);

    socket.on('game:get-state', () => {
      socket.emit('game:update', getPublicGameState());
    });

    socket.on('host:create', ({ quizData, hostId }) => {
      console.log(`Host ${hostId} (Socket: ${socket.id}) is creating a new game.`);
      // Clear any pending cleanup from a previous game
      if (hostDisconnectTimeout) {
        clearTimeout(hostDisconnectTimeout);
        hostDisconnectTimeout = null;
      }

      if (currentGame) {
        io.to(GAME_ROOM).emit('game:ended', 'A new game is starting!');
      }

      currentGame = {
        hostId: hostId,
        hostSocketId: socket.id,
        quiz: quizData, 
        state: 'LOBBY', 
        players: new Map(),
        currentQuestionIndex: 0, 
        questionStartTime: null,
        stateBeforePause: null,
        timeRemainingOnPause: null,
      };
      
      console.log('New game created. State: LOBBY');
      broadcastGameState();
    });

    socket.on('host:rejoin', ({ hostId }) => {
      if (currentGame && currentGame.hostId === hostId) {
        console.log(`Host ${hostId} has rejoined with new socket ${socket.id}`);
        // Clear the disconnect timeout since the host is back
        if (hostDisconnectTimeout) {
          clearTimeout(hostDisconnectTimeout);
          hostDisconnectTimeout = null;
        }
        currentGame.hostSocketId = socket.id;
        broadcastGameState();
      }
    });

    socket.on('player:join', ({ nickname, playerId }) => {
      if (!currentGame) return socket.emit('game:error', 'No game is currently active.');
      if (currentGame.state !== 'LOBBY') return socket.emit('game:error', 'Game has already started.');
      if (Array.from(currentGame.players.values()).some(p => p.nickname.toLowerCase() === nickname.toLowerCase())) {
        return socket.emit('game:error', 'This nickname is already taken.');
      }

      console.log(`Player joining: ${nickname} (${playerId})`);
      const player = { id: playerId, socketId: socket.id, nickname, score: 0, answered: false, answerIndex: null, disconnected: false };
      currentGame.players.set(playerId, player);
      broadcastGameState();
    });

    socket.on('player:rejoin', ({ playerId }) => {
      if (!currentGame || !currentGame.players.has(playerId)) {
         // Tell the client to clear their state because the game is gone
         return socket.emit('game:ended', 'The game you were in has ended.');
      }
      const player = currentGame.players.get(playerId);
      player.socketId = socket.id;
      player.disconnected = false;
      console.log(`Player rejoining: ${player.nickname} (${playerId})`);
      socket.emit('game:update', getPublicGameState()); // Send latest state just to this player
      broadcastGameState(); // Inform everyone else they are back
    });

    socket.on('game:start', () => {
      if (currentGame && currentGame.hostSocketId === socket.id && currentGame.state === 'LOBBY') {
        console.log('Game starting...');
        currentGame.state = 'QUESTION';
        currentGame.questionStartTime = Date.now();
        broadcastGameState();
      }
    });

    socket.on('host:toggle-pause', () => {
      if (!currentGame || currentGame.hostSocketId !== socket.id) return;

      if (currentGame.state === 'PAUSED') {
        console.log('Resuming game.');
        currentGame.state = currentGame.stateBeforePause;
        // Recalculate start time based on when it was paused
        if (currentGame.state === 'QUESTION' && currentGame.timeRemainingOnPause !== null) {
          const timeLimit = currentGame.quiz.questions[currentGame.currentQuestionIndex].timeLimit * 1000;
          currentGame.questionStartTime = Date.now() - (timeLimit - currentGame.timeRemainingOnPause);
        }
        currentGame.stateBeforePause = null;
        currentGame.timeRemainingOnPause = null;
      } else {
        console.log('Pausing game.');
        currentGame.stateBeforePause = currentGame.state;
        if (currentGame.state === 'QUESTION') {
          const elapsed = Date.now() - currentGame.questionStartTime;
          const timeLimit = currentGame.quiz.questions[currentGame.currentQuestionIndex].timeLimit * 1000;
          currentGame.timeRemainingOnPause = Math.max(0, timeLimit - elapsed);
        }
        currentGame.state = 'PAUSED';
      }
      broadcastGameState();
    });

    socket.on('player:answer', ({ playerId, answerIndex }) => {
      if (!currentGame || currentGame.state !== 'QUESTION') return;
      
      const player = currentGame.players.get(playerId);
      const question = currentGame.quiz.questions[currentGame.currentQuestionIndex];

      if (player && !player.answered) {
        player.answered = true;
        player.answerIndex = answerIndex; // Store which answer they chose
        const isCorrect = question.options[answerIndex]?.isCorrect;

        if (isCorrect) {
          const timeTaken = (Date.now() - currentGame.questionStartTime) / 1000;
          const timeLimit = question.timeLimit;
          // Award more points for faster correct answers
          let points = Math.round(Math.max(0, 1000 * (1 - (timeTaken / (timeLimit * 2)))));
          player.score += points;
        }
        broadcastGameState();
      }
    });

    socket.on('game:next', () => {
      if (!currentGame || currentGame.hostSocketId !== socket.id) return;

      switch (currentGame.state) {
        case 'QUESTION':
          currentGame.state = 'REVEAL_ANSWER';
          break;
        case 'REVEAL_ANSWER':
          currentGame.state = 'LEADERBOARD';
          break;
        case 'LEADERBOARD':
          if (currentGame.currentQuestionIndex < currentGame.quiz.questions.length - 1) {
            currentGame.currentQuestionIndex++;
            currentGame.state = 'QUESTION';
            currentGame.questionStartTime = Date.now();
            // Reset player answered state for the new question
            currentGame.players.forEach(p => {
              p.answered = false;
              p.answerIndex = null;
            }); 
          } else {
            currentGame.state = 'FINISHED';
          }
          break;
      }
      broadcastGameState();
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      if (!currentGame) return;

      // Handle host disconnection
      if (socket.id === currentGame.hostSocketId) {
        console.log('Host disconnected. Starting inactivity timer.');
        currentGame.hostSocketId = null;
        // Start a timer to end the game if the host doesn't return
        if (!hostDisconnectTimeout) {
          hostDisconnectTimeout = setTimeout(cleanupGame, HOST_RECONNECT_WINDOW);
        }
        broadcastGameState();
      } else {
        // Handle player disconnection
        let player = null;
        for (const p of currentGame.players.values()) {
          if (p.socketId === socket.id) {
            player = p;
            break;
          }
        }
        if (player) {
          console.log(`Player ${player.nickname} disconnected.`)
          player.disconnected = true;
          broadcastGameState();
        }
      }
    });
  });

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://0.0.0.0:${port}`);
    });
});