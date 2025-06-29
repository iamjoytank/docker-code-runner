const express = require('express');

// Use promisify for cleaner async/await with exec
const { promisify } = require('util');
const { exec: execCallback } = require('child_process'); // Keep original exec
const fs = require('fs').promises; // Use promise-based fs for async operations
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis'); // Import ioredis
const chalk = require('chalk');

// --- Configuration Constants ---
const PORT = process.env.PORT || 3000;
const VOLUME_NAME = 'code_execution_volume'; // Consistent volume name
const CODE_DIR = path.join(__dirname, 'code'); // Define once
const DOCKER_MEM_LIMIT = '256m';
const DOCKER_CPU_LIMIT = '0.5';
// Default file permissions (owner:rw, group:r, others:r) - Reverted from 777
const DEFAULT_FILE_PERMISSIONS = 0o644;

// Map language identifiers to their configurations
const LANGUAGES = {
	c: { ext: 'c', compileCmd: 'gcc {file} -o {output} && {output}', dockerImage: 'gcc:13' },
	cpp: { ext: 'cpp', compileCmd: 'g++ {file} -o {output} && {output}', dockerImage: 'gcc:13' },
	python: { ext: 'py', compileCmd: 'python3 {file}', dockerImage: 'python' },
	java: {
		ext: 'java',
		compileCmd: 'javac {file} && java {classname}',
		dockerImage: 'openjdk:17',
	},
	node: { ext: 'js', compileCmd: 'node {file}', dockerImage: 'node' },
};
// --- End Configuration ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Redis Setup ---
const redisConnectionOptions = {
	host: process.env.REDIS_HOST || 'localhost',
	port: 6379,
	maxRetriesPerRequest: null, // Let ioredis handle retries based on strategy
	enableReadyCheck: false,
};
// Instantiate Redis client for health checks and potentially other uses
const redis = new Redis(redisConnectionOptions);
const codeQueue = new Queue('code-execution', { connection: redisConnectionOptions });
// --- End Redis Setup ---

// Promisify exec for easier use with async/await
const exec = promisify(execCallback);

// --- Utility Functions ---
// Ensure the code directory exists on startup
async function ensureCodeDirectory() {
	try {
		await fs.mkdir(CODE_DIR, { recursive: true });
		console.log(chalk.blue(`Code directory ensured: ${CODE_DIR}`));
	} catch (error) {
		console.error(chalk.red(`Fatal: Could not create code directory ${CODE_DIR}`), error);
		process.exit(1); // Exit if we can't create the essential directory
	}
}

// Cleanup generated files
async function cleanupFiles(filePaths, jobId) {
	for (const filePath of filePaths) {
		try {
			if (
				await fs
					.stat(filePath)
					.then(() => true)
					.catch(() => false)
			) {
				await fs.unlink(filePath);
				console.log(chalk.gray(`[Worker ${jobId}] Cleaned up: ${filePath}`));
			}
		} catch (cleanupErr) {
			// Log cleanup errors but don't fail the job because of them
			console.warn(
				chalk.yellow(
					`[Worker ${jobId}] 🧹 Cleanup warning for ${filePath}: ${cleanupErr.message}`
				)
			);
		}
	}
}
// --- End Utility Functions ---

// --- API Routes ---
app.get('/health', async (req, res) => {
	try {
		// Use the ioredis client's ping method
		const redisPing = await redis.ping();
		if (redisPing !== 'PONG') {
			throw new Error('Redis ping did not return PONG');
		}
		res.json({ server: 'OK', redis: 'OK' });
	} catch (error) {
		console.error(chalk.red('Health check failed:'), error);
		res.status(500).json({ server: 'OK', redis: 'ERROR', error: error.message });
	}
});

app.post('/run', async (req, res) => {
	const { language, code } = req.body;

	if (!code || typeof code !== 'string') {
		return res.status(400).json({ error: 'Missing or invalid code field' });
	}
	if (!language || !LANGUAGES[language]) {
		return res.status(400).json({ error: 'Missing or unsupported language' });
	}

	try {
		const job = await codeQueue.add('execute', { language, code });
		console.log(chalk.green(`📥 Job Queued: ${job.id} for language: ${language}`));
		res.status(202).json({ jobId: job.id }); // 202 Accepted is appropriate for async jobs
	} catch (error) {
		console.error(chalk.red('Failed to queue job:'), error);
		res.status(500).json({ error: 'Failed to queue execution job' });
	}
});
// ⬇️ ADD THIS ENDPOINT ⬇️
app.get('/results/:jobId', async (req, res) => {
	const jobId = req.params.jobId;
	if (!jobId) {
		return res.status(400).json({ error: 'Missing Job ID' });
	}

	console.log(chalk.blue(`Received request for result of Job ID: ${jobId}`));

	try {
		// Fetch the job from the queue
		const job = await codeQueue.getJob(jobId);

		if (!job) {
			console.log(chalk.yellow(`Job ID ${jobId} not found.`));
			return res.status(404).json({ error: 'Job not found' });
		}

		// Get the current state of the job
		const state = await job.getState();
		console.log(chalk.blue(`Job ID ${jobId} state: ${state}`));

		const response = {
			jobId: job.id,
			state: state,
		};

		switch (state) {
			case 'completed':
				// Access the return value (stdout) saved when the worker promise resolved
				response.output = job.returnvalue;
				response.message = `Job ID ${jobId} completed`;
				console.log(chalk.green(`Job ID ${jobId} completed. Returning output.`));
				res.json(response);
				break;
			case 'failed':
				// Access the reason the job failed (error message)
				response.error = job.failedReason;
				response.message = `Job ID ${jobId} failed execution`;
				console.log(chalk.red(`Job ID ${jobId} failed. Returning error.`));
				// Still return 200 OK because the *request* to get the status succeeded
				res.json(response);
				break;
			case 'active':
				response.message = 'Job is currently being processed.';
				res.json(response);
				break;
			case 'waiting':
			case 'delayed':
				response.message = 'Job is waiting to be processed.';
				res.json(response);
				break;
			default:
				// Handle other states like 'stalled', 'waiting-children', 'unknown' if necessary
				response.message = `Job is in state: ${state}`;
				res.json(response);
				break;
		}
	} catch (error) {
		console.error(chalk.red(`Error fetching result for Job ID ${jobId}:`), error);
		res.status(500).json({ error: 'Failed to fetch job result' });
	}
});
// --- End API Routes ---

// --- BullMQ Worker ---
const worker = new Worker(
	'code-execution',
	async (job) => {
		const { language, code } = job.data;
		const jobId = job.id;
		const langConfig = LANGUAGES[language];
		const id = uuidv4(); // Unique ID for execution run artifacts (like .out files)

		let filename;
		let className = 'Main'; // Default class name
		let filepath;
		let containerCodePath;
		const filesToCleanup = []; // Initialize empty cleanup list

		// --- Language-Specific Setup ---
		if (language === 'java') {
			const classMatch = code.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
			if (classMatch && classMatch[1]) {
				className = classMatch[1];
				console.log(
					chalk.magenta(`[Worker ${jobId}] Extracted Java class name: ${className}`)
				);
			} else {
				console.warn(
					chalk.yellow(
						`[Worker ${jobId}] Could not find 'public class'. Using default 'Main'. Compilation might fail if this is wrong.`
					)
				);
				// If no public class is found, Java requires the filename to match a non-public class or use a default.
				// Sticking with Main.java might be okay for simple snippets, but could fail.
				// Alternatively, you could fail the job here if a public class is strictly required.
			}
			filename = `${className}.java`; // Filename MUST match the public class name
			containerCodePath = `/code/${filename}`;
			filepath = path.join(CODE_DIR, filename);
			filesToCleanup.push(filepath); // Add source file for cleanup
			filesToCleanup.push(path.join(CODE_DIR, `${className}.class`)); // Add .class file for cleanup
		} else {
			// Default naming for other languages
			filename = `${id}.${langConfig.ext}`;
			containerCodePath = `/code/${filename}`;
			filepath = path.join(CODE_DIR, filename);
			filesToCleanup.push(filepath); // Add source file for cleanup
		}
		// --- End Language-Specific Setup ---

		const containerOutputPath = `/code/${id}.out`; // Generic name for compiled output (if applicable)

		console.log(
			chalk.blue(
				`[Worker ${jobId}] Processing job for language: ${language}. Target file: ${filepath}`
			)
		);

		try {
			// 1. Write Code File
			console.log(chalk.blue(`[Worker ${jobId}] Writing code to: ${filepath}`));
			await fs.writeFile(filepath, code);
			await fs.chmod(filepath, DEFAULT_FILE_PERMISSIONS);
			console.log(chalk.green(`[Worker ${jobId}] File written and permissions set.`));

			// Utility to format command (keep as is)
			function formatCommand(template, replacements) {
				return Object.entries(replacements).reduce(
					(cmd, [key, val]) => cmd.replaceAll(`{${key}}`, val),
					template
				);
			}

			// 2. Prepare Compile/Execute Command String
			console.log(
				chalk.magenta(`[Worker ${jobId}] Using classname placeholder value: ${className}`)
			);
			const compileCommand = formatCommand(langConfig.compileCmd, {
				file: containerCodePath,
				output: containerOutputPath, // Used by C/C++
				classname: className, // Used by Java
			});
			console.log(
				chalk.magenta(
					`[Worker ${jobId}] Generated compile/run command string: ${compileCommand}`
				)
			);

			// Add C/C++ output file to cleanup if necessary
			if (compileCommand.includes(containerOutputPath) && language !== 'java') {
				// Avoid adding .out for java this way
				filesToCleanup.push(path.join(CODE_DIR, `${id}.out`));
			}

			const dockerCmd = [
				'docker run',
				'--rm',
				`--memory=${DOCKER_MEM_LIMIT}`,
				`--cpus=${DOCKER_CPU_LIMIT}`,
				'--network=none',
				// '--user=nobody',
				`-v ${VOLUME_NAME}:/code`, // Consider adding :z if SELinux is involved
				'-w /code',
				langConfig.dockerImage,
				`sh -c "${compileCommand}"`,
			].join(' ');

			console.log(chalk.blue(`[Worker ${jobId}] Executing Docker command...`));
			// 3. Execute Docker Command
			let stdout, stderr;
			try {
				const execResult = await exec(dockerCmd, { timeout: 15000 }); // Increased timeout slightly for Java
				stdout = execResult.stdout;
				stderr = execResult.stderr;
			} catch (execError) {
				// exec throws an error for non-zero exit codes
				console.error(chalk.red(`[Worker ${jobId}] Docker command failed with exit code.`));
				// Throw the original error which includes stdout/stderr if captured by exec
				throw execError;
			}

			// *** Crucial Check for Java/Compilers: Treat stderr as error if present ***
			// For compiled languages, stderr often contains vital error info even if stdout exists or exit code is 0 (e.g., javac warnings might allow java to run partially)
			if (stderr) {
				console.warn(
					chalk.yellowBright(`[Worker ${jobId}] Docker stderr detected:\n${stderr}`)
				);
				// For Java, treat ANY stderr as a potential failure indicator during compilation/runtime
				if (language === 'java' || language === 'c' || language === 'cpp') {
					// Optionally refine this: check if stdout is *also* empty before throwing
					console.error(
						chalk.red(
							`[Worker ${jobId}] Treating stderr as failure for compiled language.`
						)
					);
					throw new Error(`Execution potentially failed. Stderr:\n${stderr}`);
				}
			}

			console.log(chalk.green(`[Worker ${jobId}] Docker execution considered successful.`));

			// 4. Cleanup on Success (Moved back from previous suggestion based on user code)
			console.log(chalk.blue(`[Worker ${jobId}] Initiating cleanup for successful job...`));
			await cleanupFiles(filesToCleanup, jobId);

			return stdout; // Resolve the job promise with standard output
		} catch (error) {
			// Log error and ensure files are NOT cleaned up for inspection
			console.error(chalk.red(`❌ Error processing Job ${jobId}:`), error.message);
			console.log(
				chalk.magenta(
					`[Worker ${jobId}] Files associated with failed job (e.g., ${filepath}) are NOT being cleaned up for inspection.`
				)
			);

			// Construct a more informative error message, including stderr if present in the error object from exec
			const errorMessage = error.stderr
				? `${error.message}\nStderr:\n${error.stderr}`
				: error.message;
			// Re-throw the error to mark the job as failed in BullMQ
			throw new Error(errorMessage);
		}
	},
	{
		connection: redisConnectionOptions,
		concurrency: 5,
	}
);

// --- Worker Event Listeners ---
worker.on('completed', (job, result) => {
	console.log(chalk.green(`✅ Job ${job.id} completed successfully.`));
});

worker.on('failed', (job, err) => {
	console.error(chalk.red(`❌ Job ${job.id} failed: ${err.message}`));
	// Optional: Add more detailed logging or metrics here
});

worker.on('error', (err) => {
	// Local worker errors (e.g., connection issues)
	console.error(chalk.magenta('Worker encountered an error:'), err);
});

worker.on('active', (job) => {
	console.log(chalk.cyan(`🚀 Job ${job.id} started.`));
});
// --- End Worker Event Listeners ---

// --- Server Startup ---
async function startServer() {
	await ensureCodeDirectory(); // Make sure code dir exists before starting
	console.log(chalk.yellowBright('👷 Worker started, listening for jobs...'));
	app.listen(PORT, () => {
		console.log(chalk.cyan(`🚀 Server running at http://localhost:${PORT}`));
	});
}

startServer().catch((error) => {
	console.error(chalk.bgRed('Failed to start server:'), error);
	process.exit(1);
});
// --- End Server Startup ---

// Graceful shutdown
const gracefulShutdown = async (signal) => {
	console.log(`\n${signal} received. Shutting down gracefully...`);
	try {
		await worker.close();
		console.log('BullMQ worker closed.');
		await redis.quit();
		console.log('Redis connection closed.');
		// Optionally close the express server if needed `server.close(...)`
		process.exit(0);
	} catch (error) {
		console.error('Error during graceful shutdown:', error);
		process.exit(1);
	}
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
