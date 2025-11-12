const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

let currentGame = null;
const GAME_ROOM = 'quiz-game-room';

app.prepare().then(() => {
  const httpServer = createServer(handler);

  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  console.log('Socket.IO server initialized.');

  const getPublicGameState = () => {
    if (!currentGame) return null;
    const isQuestionState = currentGame.state === 'QUESTION';
    
    const publicQuiz = {
      ...currentGame.quiz,
      questions: currentGame.quiz.questions.map(q => ({
        ...q,
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
  
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.join(GAME_ROOM);

    socket.on('game:get-state', () => {
      socket.emit('game:update', getPublicGameState());
    });

    socket.on('host:create', ({ quizData, hostId }) => {
      console.log(`Host ${hostId} (Socket: ${socket.id}) is creating a new game.`);
      if (currentGame) {
        io.to(GAME_ROOM).emit('game:ended', 'The host has started a new game.');
      }

      currentGame = {
        hostId: hostId, // Persistent Host ID
        hostSocketId: socket.id, // Current Socket ID for the host
        quiz: quizData, 
        state: 'LOBBY', 
        players: new Map(),
        currentQuestionIndex: 0, 
        questionStartTime: null,
        // For pausing
        stateBeforePause: null,
        timeRemainingOnPause: null,
      };
      
      console.log('New game created. State: LOBBY');
      broadcastGameState();
    });

    socket.on('host:rejoin', ({ hostId }) => {
        if (currentGame && currentGame.hostId === hostId) {
            console.log(`Host ${hostId} has rejoined with new socket ${socket.id}`);
            currentGame.hostSocketId = socket.id;
            broadcastGameState(); // Update host's new socketId if needed elsewhere
        }
    });

    socket.on('player:join', ({ nickname, playerId }) => {
      if (!currentGame) return socket.emit('game:error', 'No game is currently active.');
      if (currentGame.state !== 'LOBBY') return socket.emit('game:error', 'Game has already started.');
      if (Array.from(currentGame.players.values()).some(p => p.nickname.toLowerCase() === nickname.toLowerCase())) {
        return socket.emit('game:error', 'This nickname is already taken.');
      }

      console.log(`Player joining: ${nickname} (${playerId})`);
      const player = { id: playerId, socketId: socket.id, nickname, score: 0, answered: false, disconnected: false };
      currentGame.players.set(playerId, player);
      broadcastGameState();
    });

    socket.on('player:rejoin', ({ playerId }) => {
      if (!currentGame || !currentGame.players.has(playerId)) {
         return socket.emit('game:ended', 'The game you were in has ended.');
      }
      const player = currentGame.players.get(playerId);
      player.socketId = socket.id;
      player.disconnected = false;
      console.log(`Player rejoining: ${player.nickname} (${playerId})`);
      socket.emit('game:update', getPublicGameState());
      broadcastGameState();
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
            // Adjust start time to account for the pause duration
            const timeLimit = currentGame.quiz.questions[currentGame.currentQuestionIndex].timeLimit * 1000;
            currentGame.questionStartTime = Date.now() - (timeLimit - currentGame.timeRemainingOnPause);
            currentGame.stateBeforePause = null;
            currentGame.timeRemainingOnPause = null;
        } else {
            console.log('Pausing game.');
            currentGame.stateBeforePause = currentGame.state;
            // If pausing during a question, record remaining time
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
        const isCorrect = question.options[answerIndex]?.isCorrect;

        if (isCorrect) {
          const timeTaken = (Date.now() - currentGame.questionStartTime) / 1000;
          const timeLimit = question.timeLimit;
          let points = Math.round(Math.max(0, 1000 * (1 - (timeTaken / (timeLimit * 2)))));
          player.score += points;
        }
        broadcastGameState();
      }
    });

    socket.on('game:next', () => {
      if (!currentGame || currentGame.hostSocketId !== socket.id) return;

      if (currentGame.state === 'QUESTION') {
        currentGame.state = 'LEADERBOARD';
      } else if (currentGame.state === 'LEADERBOARD') {
        if (currentGame.currentQuestionIndex < currentGame.quiz.questions.length - 1) {
          currentGame.currentQuestionIndex++;
          currentGame.state = 'QUESTION';
          currentGame.questionStartTime = Date.now();
          currentGame.players.forEach(p => p.answered = false); 
        } else {
          currentGame.state = 'FINISHED';
        }
      }
      broadcastGameState();
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      if (!currentGame) return;

      if (socket.id === currentGame.hostSocketId) {
        console.log('Host disconnected. The game will persist.');
        currentGame.hostSocketId = null; // Host is temporarily offline
        broadcastGameState();
      } else {
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
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});