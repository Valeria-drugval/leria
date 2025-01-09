
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// Configuration
const token = ''; // Токен бота. Получите его у @BotFather
const admins = []; // В массиве должны быть идентификаторы администраторов. Id можно получить в боте @userinfobot
const VOTING_THRESHOLD = 0.5; // Процент проголосовавших, чтобы одобрить мем 0.5 - 50%

const bot = new TelegramBot(token, { polling: true });
const db = new sqlite3.Database('./memes.db');
db.run = promisify(db.run);
db.all = promisify(db.all);
db.get = promisify(db.get);

async function initDatabase() {
	await db.run(`CREATE TABLE IF NOT EXISTS memes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        caption TEXT DEFAULT '',
        file_id TEXT,
        type TEXT DEFAULT 'photo',
        status TEXT DEFAULT 'Pending',
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

	await db.run(`CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meme_id INTEGER,
        admin_id INTEGER,
        vote TEXT,
        message_id INTEGER,
        chat_id INTEGER,
        UNIQUE(meme_id, admin_id),
        FOREIGN KEY(meme_id) REFERENCES memes(id)
    )`);

	await db.run(`CREATE TABLE IF NOT EXISTS ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        idea TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

const STATES = {
	IDLE: 'idle',
	MEME_SUBMISSION: 'meme_submission',
	IDEA_SUBMISSION: 'idea_submission',
	CONFIRM_DELETION: 'confirm_deletion',
};

const ignoredResponses = [STATES.CONFIRM_DELETION];

const userStates = new Map();

function setUserState(userId, state) {
	userStates.set(userId, state);
}

function getUserState(userId) {
	return userStates.get(userId) || STATES.IDLE;
}

function setNewState(userId, newState) {
	const currentState = getUserState(userId);
	if (currentState !== newState) {
		setUserState(userId, newState);
	}
}

const stateHandlers = {
	[STATES.MEME_SUBMISSION]: (msg, userId, username) => {
		if (msg.photo) {
			const fileId = msg.photo[msg.photo.length - 1].file_id;
			const caption = msg.caption || '';
			handleMemeSubmission(userId, username, caption, fileId, 'photo');
		} else if (msg.video) {
			const fileId = msg.video.file_id;
			handleMemeSubmission(userId, username, caption, fileId, 'video');
		} else if (msg.text) {
			bot.sendMessage(userId, 'Пожалуйста, отправьте изображение или видео, а не текст.');
		}
	},
	[STATES.IDEA_SUBMISSION]: (msg, userId, username) => {
		if (msg.text) {
			handleIdeaSubmission(userId, username, msg.text);
		} else if (msg.photo) {
			bot.sendMessage(userId, 'Пожалуйста, отправьте текстовую идею, а не изображение.');
		}
	},
};

const userCommands = {
	'/start': (userId) => {
		sendWelcomeMessage(userId);
		setUserState(userId, STATES.IDLE);
	},
	'/id': (userId) => {
		bot.sendMessage(userId, `Ваш ID в Telegram: ${userId}`);
	},
	'Предложить мем': (userId) => {
		setNewState(userId, STATES.MEME_SUBMISSION);
		bot.sendMessage(userId, 'Пожалуйста, отправьте изображение или видео мема.');
	},
	'Предложить идею': (userId) => {
		setNewState(userId, STATES.IDEA_SUBMISSION);
		bot.sendMessage(userId, 'Пожалуйста, отправьте текст вашей идеи для мема.');
	},
};

const adminCommands = {
	'/menu': (userId) => {
		showAdminMenu(userId);
	},
	'Посмотреть мемы': (userId) => {
		handleViewMemes(userId);
	},
	'Посмотреть идеи': (userId) => {
		handleViewIdeas(userId);
	},
	'Удалить все мемы': (userId) => {
		confirmDeletion(userId, 'memes');
	},
	'Удалить все идеи': (userId) => {
		confirmDeletion(userId, 'ideas');
	},
	Назад: (userId) => {
		sendWelcomeMessage(userId);
	},
};

const commands = [
	{ command: 'start', description: 'Запуск бота' },
	{ command: 'id', description: 'Получить свой ID' },
	{ command: 'menu', description: 'Открыть меню администратора' },
];

bot.setMyCommands(commands);

function sendWelcomeMessage(userId) {
	bot.sendMessage(userId, 'Добро пожаловать! Вы можете предложить мем или идею для мема.', {
		reply_markup: {
			keyboard: [['Предложить мем', 'Предложить идею']],
			resize_keyboard: true,
		},
	});
}

bot.on('message', (msg) => {
	const userId = msg.from.id;
	const text = msg.text;
	const username = msg.from.username;
	const chatType = msg.chat.type;

	if (chatType === 'group' || chatType === 'supergroup') {
		return;
	}

	const currentState = getUserState(userId);

	const isAdmin = admins.includes(userId);
	const commands = isAdmin ? { ...userCommands, ...adminCommands } : userCommands;
	if (commands[text]) {
		commands[text](userId);
	} else if (currentState !== STATES.IDLE) {
		if (stateHandlers[currentState]) {
			stateHandlers[currentState](msg, userId, username);
		}
	} else if (!ignoredResponses.includes(currentState)) {
		bot.sendMessage(userId, 'Неизвестная команда. Попробуйте снова.');
	}
});

async function saveIdea(userId, username, ideaText) {
	await db.run('INSERT INTO ideas (user_id, username, idea) VALUES (?, ?, ?)', [userId, username, ideaText]);
}

async function handleIdeaSubmission(userId, username, ideaText) {
	try {
		await saveIdea(userId, username, ideaText);
		bot.sendMessage(userId, 'Ваша идея была отправлена.');
		notifyAdminsAboutIdea(ideaText, username);
	} catch (error) {
		console.error('Ошибка при отправке идеи:', error);
		bot.sendMessage(userId, 'Произошла ошибка при отправке вашей идеи.');
	}
	setUserState(userId, STATES.IDLE);
}

function notifyAdminsAboutIdea(ideaText, username) {
	const message = `@${username || 'Неизвестный'} предложил идею для мема:\n"${ideaText}"`;

	admins.forEach((adminId) => {
		bot.sendMessage(adminId, message);
	});
}

async function saveMeme(userId, username, caption, fileId, type) {
	await db.run('INSERT INTO memes (user_id, username, caption, file_id, type) VALUES (?, ?, ?, ?, ?)', [
		userId,
		username,
		caption,
		fileId,
		type,
	]);
	const result = await db.get('SELECT last_insert_rowid() as id');
	return result.id;
}

async function handleMemeSubmission(userId, username, caption, fileId, type) {
	try {
		const memeId = await saveMeme(userId, username, caption, fileId, type);
		notifyAdminsAboutMeme(caption, fileId, memeId, username, type);
		bot.sendMessage(userId, 'Ваш мем отправлен на рассмотрение.');
	} catch (error) {
		console.error('Ошибка при сохранении мема:', error);
		bot.sendMessage(userId, 'Произошла ошибка при отправке вашего мема.');
	}
	setUserState(userId, STATES.IDLE);
}

async function notifyAdminsAboutMeme(caption, fileId, memeId, username, type) {
	const messageCaption = `${caption ?? ''}\n@${username ?? 'Неизвестный'} предложил мем.`;

	admins.forEach(async (adminId) => {
		let sentMessage;

		const replyMarkup = {
			inline_keyboard: [
				[
					{
						text: '✅ Одобрить',
						callback_data: `vote_${memeId}_approve`,
					},
					{
						text: '❌ Отклонить',
						callback_data: `vote_${memeId}_reject`,
					},
				],
			],
		};

		if (type === 'photo') {
			sentMessage = await bot.sendPhoto(adminId, fileId, {
				caption: messageCaption,
				reply_markup: replyMarkup,
			});
		} else if (type === 'video') {
			sentMessage = await bot.sendVideo(adminId, fileId, {
				caption: messageCaption,
				reply_markup: replyMarkup,
			});
		}

		await db.run('INSERT INTO votes (meme_id, admin_id, message_id, chat_id) VALUES (?, ?, ?, ?)', [
			memeId,
			adminId,
			sentMessage.message_id,
			adminId,
		]);
	});
}

async function handleVote(query) {
	const [action, memeId, vote] = query.data.split('_');
	const adminId = query.from.id;

	if (!admins.includes(adminId)) {
		return bot.answerCallbackQuery(query.id, {
			text: 'Вы не являетесь администратором.',
		});
	}

	try {
		const currentVote = await db.get('SELECT vote FROM votes WHERE meme_id = ? AND admin_id = ?', [
			memeId,
			adminId,
		]);

		if (currentVote && currentVote.vote === vote) {
			return bot.answerCallbackQuery(query.id, {
				text: 'Вы уже проголосовали таким образом.',
			});
		}

		await db.run(
			`INSERT INTO votes (meme_id, admin_id, vote) VALUES (?, ?, ?)
            ON CONFLICT(meme_id, admin_id) DO UPDATE SET vote = ?`,
			[memeId, adminId, vote, vote]
		);

		const votes = await db.all('SELECT vote, COUNT(*) as count FROM votes WHERE meme_id = ? GROUP BY vote', [
			memeId,
		]);
		const approveCount = votes.find((v) => v.vote === 'approve')?.count || 0;
		const rejectCount = votes.find((v) => v.vote === 'reject')?.count || 0;
		const totalVotes = approveCount + rejectCount;
		const totalAdmins = admins.length;

		const meme = await db.get('SELECT caption, username FROM memes WHERE id = ?', [memeId]);
		const memeCaption = meme?.caption ? `\n\n${meme.caption}` : '';
		const memeUsername = meme?.username ? `\n@${meme.username}` : '';

		let caption = `${memeCaption}${memeUsername}\n\n✅ ${approveCount} / ${totalAdmins} | ❌ ${rejectCount} / ${totalAdmins}`;
		let canFinish = approveCount !== rejectCount && totalVotes >= totalAdmins * VOTING_THRESHOLD;

		const replyMarkup = {
			inline_keyboard: [
				[
					{
						text: '✅ Одобрить',
						callback_data: `vote_${memeId}_approve`,
					},
					{
						text: '❌ Отклонить',
						callback_data: `vote_${memeId}_reject`,
					},
				],
			],
		};

		if (canFinish) {
			replyMarkup.inline_keyboard.push([
				{
					text: 'Завершить голосование',
					callback_data: `finish_${memeId}`,
				},
			]);
		}

		const voteMessages = await db.all('SELECT chat_id, message_id FROM votes WHERE meme_id = ?', [memeId]);
		for (const { chat_id, message_id } of voteMessages) {
			await bot.editMessageCaption(caption, {
				chat_id,
				message_id,
				reply_markup: replyMarkup,
			});
		}

		bot.answerCallbackQuery(query.id, { text: 'Ваш голос учтен.' });
	} catch (error) {
		console.error('Ошибка при обработке голосования:', error);
		bot.answerCallbackQuery(query.id, {
			text: 'Произошла ошибка при голосовании.',
		});
	}
}

async function finishVoting(query) {
	const memeId = query.data.split('_')[1];

	try {
		const votes = await db.all('SELECT vote, COUNT(*) as count FROM votes WHERE meme_id = ? GROUP BY vote', [
			memeId,
		]);
		const approveCount = votes.find((v) => v.vote === 'approve')?.count || 0;
		const rejectCount = votes.find((v) => v.vote === 'reject')?.count || 0;
		const status = approveCount > rejectCount ? 'Approved' : 'Rejected';

		await db.run('UPDATE memes SET status = ? WHERE id = ?', [status, memeId]);

		const meme = await db.get('SELECT caption, username FROM memes WHERE id = ?', [memeId]);
		const memeCaption = meme?.caption ? `${meme.caption}` : '';
		const memeUsername = meme?.username ? `\n@${meme.username}` : '';

		const finalCaption = `${memeCaption}${memeUsername}\n\nГолосование завершено.\n✅ Одобрено: ${approveCount}\n❌ Отклонено: ${rejectCount}\nСтатус: ${status === 'Approved' ? 'Одобрено' : 'Отклонено'
			}`;
		const voteMessages = await db.all('SELECT chat_id, message_id FROM votes WHERE meme_id = ?', [memeId]);

		for (const { chat_id, message_id } of voteMessages) {
			try {
				await bot.editMessageCaption(finalCaption, {
					chat_id,
					message_id,
				});
			} catch (error) {
				console.error('Ошибка при изменении подписи сообщения:', error);
			}
		}

		const memeUser = await db.get('SELECT user_id FROM memes WHERE id = ?', [memeId]);
		const userMessage = status === 'Approved' ? 'Ваш мем был одобрен!' : 'Ваш мем был отклонен.';
		await bot.sendMessage(memeUser.user_id, userMessage);

		bot.answerCallbackQuery(query.id, { text: 'Голосование завершено.' });
	} catch (error) {
		console.error('Ошибка при завершении голосования:', error);
		bot.answerCallbackQuery(query.id, {
			text: 'Произошла ошибка при завершении голосования.',
		});
	}
}

bot.on('callback_query', async (query) => {
	const [action, ...args] = query.data.split('_');

	switch (action) {
		case 'vote':
			await handleVote(query);
			break;
		case 'finish':
			await finishVoting(query);
			break;
	}
});

async function editMessage(chatId, messageId, text, keyboard) {
	try {
		await bot.editMessageText(text, {
			chat_id: chatId,
			message_id: messageId,
			reply_markup: { inline_keyboard: keyboard },
		});
	} catch (error) {
		await handleEditMessageError(error, chatId, messageId, text, keyboard);
	}
}

async function handleEditMessageError(error, chatId, messageId, text, keyboard) {
	if (
		error.response &&
		error.response.statusCode === 400 &&
		error.response.body.description.includes('there is no text in the message to edit')
	) {
		try {
			await bot.editMessageCaption(text, {
				chat_id: chatId,
				message_id: messageId,
				reply_markup: { inline_keyboard: keyboard },
			});
		} catch (captionError) {
			console.error('Ошибка при редактировании подписи:', captionError);
		}
	} else {
		console.error('Ошибка при редактировании текста сообщения:', error);
	}
}

function showAdminMenu(userId) {
	const menu = {
		reply_markup: {
			keyboard: [['Посмотреть мемы', 'Посмотреть идеи'], ['Удалить все мемы', 'Удалить все идеи'], ['Назад']],
			resize_keyboard: true,
		},
	};
	bot.sendMessage(userId, 'Вы в меню администратора. Выберите действие:', menu);
}

async function handleViewMemes(userId) {
	let query = 'SELECT * FROM memes';

	const memes = await db.all(query);

	if (memes.length > 0) {
		for (const meme of memes) {
			const caption = `ID: ${meme.id}\nСтатус: ${meme.status === 'Approved' ? 'Одобрено' : 'Отклонено'}`;

			if (meme.type === 'photo') {
				await bot.sendPhoto(userId, meme.file_id, { caption });
			} else if (meme.type === 'video') {
				await bot.sendVideo(userId, meme.file_id, { caption });
			}
		}
	} else {
		bot.sendMessage(userId, 'Нет доступных мемов.');
	}
}

async function handleViewIdeas(userId) {
	const ideas = await db.all('SELECT * FROM ideas');
	const message =
		ideas.length > 0 ? ideas.map((idea) => `ID: ${idea.id}, Идея: ${idea.idea}`).join('\n') : 'Нет доступных идей.';
	bot.sendMessage(userId, message);
}

const questions = [
	{
		question: 'Продолжи ряд: бочка, огурец, ...',
		correctAnswer: 'апельсин',
	},
	{
		question: 'Супергеройское имя Марка',
		correctAnswer: 'слэш',
	},
	{
		question: 'Кто третий?',
		correctAnswer: 'не знаю',
	},
];

async function confirmDeletion(userId, type) {
	const question = questions[Math.floor(Math.random() * questions.length)];
	setUserState(userId, STATES.CONFIRM_DELETION);
	bot.sendMessage(userId, `${question.question}\nВведите ваш ответ:`);

	bot.once('message', async (msg) => {
		if (msg.text.toLowerCase() === question.correctAnswer) {
			await deleteAll(type);
			bot.sendMessage(userId, `Все ${type === 'memes' ? 'мемы' : 'идеи'} удалены.`);
		} else {
			bot.sendMessage(userId, 'Ответ неверный. Удаление отменено.');
		}
		setUserState(userId, STATES.IDLE);
	});
}

async function deleteAll(type) {
	if (type === 'memes') {
		await db.run('DELETE FROM memes');
		await db.run('DELETE FROM votes');
	} else if (type === 'ideas') {
		await db.run('DELETE FROM ideas');
	}
}

process.on('unhandledRejection', (reason, promise) => {
	console.error('Необработанное исключение (promise):', reason);
});

initDatabase()
	.then(() => {
		console.log('База данных и бот успешно инициализированы.');
	})
	.catch((error) => console.error('Ошибка инициализации:', error));
