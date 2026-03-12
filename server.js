import 'dotenv/config';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.argv = [process.argv[0], process.argv[1], './build/server/index.js'];
import('./node_modules/@react-router/serve/dist/cli.js');
