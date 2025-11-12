const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

let currentGame = null;
const GAME_ROOM = 'kahoot-game-room';

app.prepare().then(() => {
  const httpServer = createServer(handler);

  const io = new Server(httpServer, {
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    }
  });

  console.log('Socket.IO server initialized.');

  const sendGameStateToSocket = (socket) => {
    if (!currentGame) {
        socket.emit('game:update', null);
        return;
    }
    const isQuestionState = currentGame.state === 'QUESTION';
    const publicQuiz = {
      ...currentGame.quiz,
      questions: isQuestionState
        ? currentGame.quiz.questions.map(q => ({
          ...q,
          options: q.options.map(o => ({ text: o.text }))
        }))
        : currentGame.quiz.questions,
    };
    const publicGameState = {
      ...currentGame,
      quiz: publicQuiz,
      players: Array.from(currentGame.players.values()),
    };
    socket.emit('game:update', publicGameState);
  }

  const broadcastGameState = () => {
    sendGameStateToSocket(io.to(GAME_ROOM));
  }
  
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.join(GAME_ROOM);

    socket.on('game:get-state', () => {
      // Send the current game state ONLY to the requester
      sendGameStateToSocket(socket);
    });

    socket.on('host:create', (quizData) => {
      console.log(`Host ${socket.id} is creating a new game.`);
      
      // *** FIX: Notify OTHERS that the game ended, NOT the new host ***
      if (currentGame) {
        socket.broadcast.to(GAME_ROOM).emit('game:ended', 'The host has started a new game.');
      }

      currentGame = {
        hostId: socket.id, 
        quiz: quizData, 
        state: 'LOBBY', 
        players: new Map(),
        currentQuestionIndex: 0, 
        questionStartTime: null, 
        firstCorrectPlayerId: null,
      };
      
      console.log('New game created. State: LOBBY');
      broadcastGameState();
    });

    socket.on('player:join', ({ nickname, playerId }) => {
      if (!currentGame) return socket.emit('game:error', 'No game is currently active.');
      if (currentGame.state !== 'LOBBY') return socket.emit('game:error', 'Game has already started.');
      if (Array.from(currentGame.players.values()).some(p => p.nickname.toLowerCase() === nickname.toLowerCase())) {
        return socket.emit('game:error', 'This nickname is already taken.');
      }

      console.log(`Player joining: ${nickname} (${playerId})`);
      const player = { id: playerId, socketId: socket.id, nickname, score: 0, answered: false };
      currentGame.players.set(playerId, player);
      broadcastGameState();
    });

    socket.on('game:start', () => {
      if (currentGame && currentGame.hostId === socket.id && currentGame.state === 'LOBBY') {
        console.log('Game starting...');
        currentGame.state = 'QUESTION';
        currentGame.questionStartTime = Date.now();
        broadcastGameState();
      }
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
          let points = Math.round(Math.max(0, 1000 * (1 - (timeTaken / (timeLimit * 1.5)))));
          
          if (currentGame.firstCorrectPlayerId === null) {
            currentGame.firstCorrectPlayerId = playerId;
            points += 200;
          }
          player.score += points;
        }
        broadcastGameState();
      }
    });

    socket.on('game:next', () => {
      if (!currentGame || currentGame.hostId !== socket.id) return;

      if (currentGame.state === 'QUESTION') {
        currentGame.state = 'LEADERBOARD';
      } else if (currentGame.state === 'LEADERBOARD') {
        if (currentGame.currentQuestionIndex < currentGame.quiz.questions.length - 1) {
          currentGame.currentQuestionIndex++;
          currentGame.state = 'QUESTION';
          currentGame.questionStartTime = Date.now();
          currentGame.firstCorrectPlayerId = null;
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

      if (socket.id === currentGame.hostId) {
        console.log('Host disconnected. Ending game.');
        io.to(GAME_ROOM).emit('game:ended', 'The host has disconnected. The game is over.');
        currentGame = null;
      } else {
        let playerIdToRemove = null;
        for (const [id, player] of currentGame.players.entries()) {
          if (player.socketId === socket.id) {
            playerIdToRemove = id;
            break;
          }
        }
        if (playerIdToRemove) {
          console.log(`Player ${currentGame.players.get(playerIdToRemove).nickname} disconnected.`)
          currentGame.players.delete(playerIdToRemove);
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