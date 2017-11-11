const redis = require("redis");
// TODO: make createClient its own method, in order
// to pass in custom config options
const fs = require("fs");
const path = require("path");
const JSONStream = require("JSONStream");
const { Transform } = require("stream");
const { spawn } = require("child_process");
const { logMemory } = require(path.resolve(__dirname, "utils"));
const bluebird = require("bluebird");

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

// later: configuration option - include full string

// path represents a relative path from directory of app.js
// or absolute path
// currently expects array of completions in a json file


const validateInputIsArray = (input, funcName) => {
  if (!Array.isArray(input)) {
    throw new TypeError(
      `The argument to ${funcName} must be an array`
    );
  }
};

const byteSize = (str) => {
  return String(Buffer.byteLength(String(str), "utf8"));
};

const toRedisProtocol = (command) => {
  let protocol = "";
  protocol += "*" + String(command.length) + "\r\n"
  command.forEach(arg => {
    protocol += "$" + byteSize(arg) + "\r\n";
    protocol += String(arg) + "\r\n";
  });
  // console.log(protocol);
  return protocol;
};

const translator = new Transform({
  objectMode: true,

  transform(item, encoding, callback) {
    const completion = item.completion || item;
    const score = item.score || 0;
    const prefixes = Prefixy.extractPrefixes(completion);

    let chunk = "";
    // logging fn here
    prefixes.forEach(prefix =>
      chunk += toRedisProtocol(['zadd', prefix, -score, completion])
    );

    callback(null, chunk);
  }
});

class Prefixy {
  constructor() {}

  static extractPrefixes(completion) {
    const prefixes = [];
    completion = completion.toLowerCase();
    for (let i = 1; i <= completion.length; i++) {
      prefixes.push(completion.slice(0, i));
    }
    return prefixes;
  }

  async invoke(cb) {
    this.client = redis.createClient();
    let result;

    try {
      result = await cb();
    } catch(e) {
      console.log(e);
    }

    this.client.quit();
    return result;
  }

  importFile(filePath) {
    const json = fs.createReadStream(path.resolve(process.cwd(), filePath), "utf8");
    const parser = JSONStream.parse("*");
    const redis = spawn("redis-cli", ["--pipe"],
      { stdio: ["pipe", process.stdout, process.stderr] });

    // const file = fs.createWriteStream(path.resolve(__dirname, "sample-data/protocol.txt"), {"flags": "a"});
    // json.pipe(parser).pipe(this.ts).pipe(file);

    json.pipe(parser).pipe(translator).pipe(redis.stdin);
  }

  // takes an array of strings or an array of completions with scores
  // e.g. [{ completion: "string", score: 13 }]
  insertCompletions(array) {
    validateInputIsArray(array, "insertCompletions");

    const commands = [];
    array.forEach(item => {
      const completion = item.completion || item;
      const score = item.score || 0;
      const prefixes = Prefixy.extractPrefixes(completion);

      prefixes.forEach(prefix =>
        commands.push(['zadd', prefix, -score, completion])
      );
    });

    return this.client.batch(commands).execAsync();
  }

  deleteCompletions(completions) {
    validateInputIsArray(completions, "deleteCompletions");

    const commands = [];
    completions.forEach(completion => {
      const prefixes = Prefixy.extractPrefixes(completion);

      prefixes.forEach(prefix =>
        commands.push(["zrem", prefix, completion])
      );
    });

    return this.client.batch(commands).execAsync();
  }

  search(prefixQuery, opts={}) {
    const defaultOpts = { limit: 0, withScores: false };
    opts = { ...defaultOpts, ...opts }
    const limit = opts.limit - 1;

    let args = [prefixQuery.toLowerCase(), 0, limit];
    if (opts.withScores) args = args.concat('WITHSCORES');
    return this.client.zrangeAsync(...args);
  }

  // we increment by -1, bc this enables us to sort
  // by frequency plus ascending lexographical order in Redis
  fixedIncrementScore(completion) {
    const prefixes = Prefixy.extractPrefixes(completion);
    const commands = prefixes.map(prefix =>
      ['zadd', prefix, 'XX', 'INCR', -1, completion]
    );

    return this.client.batch(commands).execAsync();
  }

  // similar to fixedIncrementScore, but will add completion
  // to bucket if not present

  dynamicIncrementScore(completion, limit) {
    if (limit >= 0) {
      return this.dynamicBucketIncrementScore(completion, limit);
    }

    const prefixes = Prefixy.extractPrefixes(completion);
    const commands = prefixes.map(prefix =>
      ['zincrby', prefix, -1, completion]
    );

    return this.client.batch(commands).execAsync();
  }

  async dynamicBucketIncrementScore(completion, limit) {
    const prefixes = Prefixy.extractPrefixes(completion);
    const commands = [];
    let count;
    let last;

    for (var i = 0; i < prefixes.length; i++) {
      count = await this.client.zcountAsync(prefixes[i], '-inf', '+inf');
      let newScore;

      if (count >= limit) {
        last = await this.client.zrangeAsync(prefixes[i], limit - 1, limit - 1, 'WITHSCORES');
        newScore = last[1] - 1;
        commands.push(['zremrangebyrank', prefixes[i], limit - 1, -1]);
        commands.push(['zadd', prefixes[i], newScore, completion]);
      } else {
        commands.push(['zincrby', prefixes[i], -1, completion]);
      }
    }

    return this.client.batch(commands).execAsync();
  }

  // Disk Persistence Methods

  async loadPrefixFromDisk(prefix) {
    await this.client.zremrangebyrank(prefix, 0, -1);

    const targetPath = path.resolve(__dirname, `data/${prefix}.json`);
    const commands = [];

    if (!fs.existsSync(targetPath)) {
      return Promise.resolve("");
    }

    const json = fs.readFileSync(targetPath, 'utf8');
    const data = JSON.parse(json);

    for (var i = 0; i < data.length; i += 2) {
      commands.push(['zadd', prefix, data[i + 1], data[i]]);
    }

    return await this.client.batch(commands).execAsync();
  }

  async persistPrefix(prefix) {
    const writeFile = bluebird.promisify(fs.writeFile);
    const unlink = bluebird.promisify(fs.unlink);
    const completions = await this.client.zrangeAsync(prefix, 0, -1, 'WITHSCORES');
    const targetPath = path.resolve(__dirname, `data/${prefix}.json`);
    const data = JSON.stringify(completions);

    if (completions.length === 0 && fs.existsSync(targetPath)) {

      return unlink(targetPath).then((err) => {
        if (err) { return console.log(err); }

        console.log(`${prefix} unlinked`);
      });

    } else if (completions.length === 0) {

      return Promise.resolve("");

    } else {

      return writeFile(targetPath, data, 'utf8').then((err) => {
        if (err) { return console.log(err); }

        console.log(`${prefix} saved`);
      });

    }
  }

  async persistPrefixes(prefixes) {
    for (var i = 0; i < prefixes.length; i++) {
      await this.persistPrefix(prefixes[i]);
    }
  }

  async persistInsertCompletions(array) {
    validateInputIsArray(array, "insertCompletions");

    let allPrefixes = [];
    const commands = [];
    array.forEach(item => {
      const completion = item.completion || item;
      const score = item.score || 0;
      const prefixes = Prefixy.extractPrefixes(completion);
      allPrefixes = [...allPrefixes, ...prefixes];

      prefixes.forEach(prefix => 
        commands.push(['zadd', prefix, -score, completion])
      );
    });

    return this.client.batch(commands).execAsync().then(async () => {
      await this.persistPrefixes(allPrefixes);
      return "persist success";
    });
  }

  async persistDeleteCompletions(completions) {
    validateInputIsArray(completions, "deleteCompletions");

    let allPrefixes = [];
    const commands = [];
    completions.forEach(completion => {
      const prefixes = Prefixy.extractPrefixes(completion);
      allPrefixes = [...allPrefixes, ...prefixes];

      prefixes.forEach(prefix =>
        commands.push(["zrem", prefix, completion])
      );
    });

    return this.client.batch(commands).execAsync().then(async () => {
      await this.persistPrefixes(allPrefixes);
      return "persist success";
    });
  }

  async persistSearch(prefixQuery, opts={}) {
    const defaultOpts = { limit: 0, withScores: false };
    opts = { ...defaultOpts, ...opts }
    const limit = opts.limit - 1;

    let args = [prefixQuery.toLowerCase(), 0, limit];
    if (opts.withScores) args = args.concat('WITHSCORES');
    
    let result = await this.client.zrangeAsync(...args);

    if (result.length === 0) {
      await this.loadPrefixFromDisk(prefixQuery)
      result = await this.client.zrangeAsync(...args);
    }

    return result;
  }

  async persistDynamicIncrementScore(completion, limit) {
    if (limit >= 0) {
      return this.persistDynamicBucketIncrementScore(completion, limit);
    }

    const prefixes = Prefixy.extractPrefixes(completion);
    const commands = prefixes.map(prefix =>
      ['zincrby', prefix, -1, completion]
    );

    return this.client.batch(commands).execAsync().then(async () => {
      await this.persistPrefixes(prefixes);
      return "persist success";
    });;
  }

  async persistDynamicBucketIncrementScore(completion, limit) {
    const prefixes = Prefixy.extractPrefixes(completion);
    const commands = [];
    let count;
    let last;

    for (var i = 0; i < prefixes.length; i++) {
      count = await this.client.zcountAsync(prefixes[i], '-inf', '+inf');

      if (count >= limit) {
        last = await this.client.zrangeAsync(prefixes[i], limit - 1, limit - 1, 'WITHSCORES');
        const newScore = last[1] - 1;
        commands.push(['zremrangebyrank', prefixes[i], limit - 1, -1]);
        commands.push(['zadd', prefixes[i], newScore, completion]);
      } else {
        commands.push(['zincrby', prefixes[i], -1, completion]);
      }
    }

    return this.client.batch(commands).execAsync().then(async () => {
      await this.persistPrefixes(prefixes);
      return "persist success";
    });
  }
}

module.exports = new Prefixy();

