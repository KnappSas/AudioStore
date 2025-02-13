class Streamer {
  static nextID = 0;
  static getNextID() {
    return AudioWorkletStreamer.nextID++;
  }

  /**
   * streamer constructor
   *
   * @method constructor
   *
   * @param  {String}     url   – audio asset url
   * @param  {AudioStore} store – AudioStore instance
   * @return {Streamer}
   */

  constructor( url, store, ac ) {
    this.streamID = Streamer.getNextID();
    this.ac     = ac;
    this.store  = store;
    this.trackNode = this.ac.createGain();
    this.gain   = this.ac.createGain();

    if (url) {
      if (url.length > 0) {
        this.url = url;
        this.name = url.split('/').pop().split('.')[0];
      }

      const tmpClip = { fileName: url };
      this.clips.push(tmpClip);
    }

    // throwaway audio buffer
    this.garbageBuffer = this.ac.createBuffer( 1, 1, 44100 );

    this.startTime   = null;
    this.startOffset = null;

    this.stopped = true;
    this.ready   = false;

    this.trackNode.connect( this.gain );
    //this.gain.connect( this.ac.destination );
  }

  addClip(clip) {
    this.url    = clip.fileName;
    this.name   = this.url.split('/').pop().split('.')[ 0 ];
  }

  /**
   * Preload a chunk so that a subsequent call to `stream()` can
   * begin immediately without hitting thr database
   *
   * @method prime
   *
   * @param  {Number} offset – offset in seconds (defaults to 0 or last time )
   * @return {Promise}       – resolves with `this` on completion
   */

  async prime( offset ) {
    if ( typeof offset !== 'number' ) {
      offset = this.startOffset !== null ? this.startOffset : 0;
    }

    if ( !this.ready ) {
      throw new Error( `asset ${ this.name } not loaded` );
    }

    if ( offset >= this.duration ) {
      throw new Error( `${ offset } is greater than ${ this.duration }` );
    }

    const store    = this.store;
    const duration = Math.min( 1, this.duration - offset );
    const record   = await store.getAudioBuffer( this.name, offset, duration );
    const src      = this.ac.createBufferSource();

    src.buffer = record;

    this.primed = { offset, src };

    return this;
  }

  /**
   * Begin playback at the supplied offset (or resume playback)
   *
   * @method stream
   *
   * @param  {Number} offset – offset in seconds (defaults to 0 or last time )
   * @return {Streamer}
   */

  stream( offset ) {
    if ( typeof offset !== 'number' ) {
      offset = this.startOffset !== null ? this.startOffset : 0;
    }

    if ( !this.ready ) {
      throw new Error( `asset ${ this.name } not loaded` );
    }

    if ( this.stopped === false ) {
      throw new Error( `stream ${ this.name } is already playing` );
    }

    if ( this.ending ) {
      this.ending.onended = () => {};
      this.ending = null;
    }

    if ( offset >= this.duration ) {
      return this.stop();
    }

    // mobile browsers require the first AudioBuuferSourceNode#start() call
    // to happen in the same call stack as a user interaction.
    //
    // out Promise-based stuff breaks that, so we try to get ourselves onto
    // a good callstack here and play an empty sound if we haven't done
    // so already
    if ( this.garbageBuffer ) {
      const src = this.ac.createBufferSource();
      src.buffer = this.garbageBuffer;
      src.start( 0 );
      delete this.garbageBuffer;
    }

    this.stopped = false;
    this.startOffset = offset;

    // console.info( `streaming ${ this.name } @ ${ offset }s` );

    const play = ( src, when, offset, output ) => {
      const logtime = ( when - this.ac.currentTime ) * 1000;
      const logstr  = `playing chunk ${ this.name } @ ${ offset }s`;

      // this.logtimer = setTimeout( () => console.info( logstr ), logtime );

      src.connect( output );
      src.start( when );

      const dur = src.buffer.duration;

      when += dur;
      offset += dur;

      if ( offset >= this.duration ) {
        this.ending = src;
        src.onended = () => this.stop();
        // console.info( `end of file ${ this.name }` );
        return;
      }

      const fetchtime = ( when - this.ac.currentTime ) * 1000 - 2000;

      this.fetchtimer = setTimeout( () => {
        // console.info( `need chunk ${ this.name } @ ${ offset }s` );

        /* eslint-disable no-use-before-define */
        next( when, offset, output );
      }, fetchtime );
    };

    const next = ( when = 0, offset = 0, output ) => {
      const chunkDuration = Math.min( 1, this.duration - offset );
      this.store.getAudioBuffer( this.name, offset, chunkDuration )
      .then( record => {
        if ( this.stopped || output !== this.trackNode ) {
          return;
        }

        const ab  = record;
        const src = this.ac.createBufferSource();

        src.buffer = ab;

        if ( when === 0 ) {
          when = this.ac.currentTime;
        }

        if ( this.startTime === null ) {
          this.startTime = when;
        }

        play( src, when, offset, output );
      })
      .catch( err => console.error( err ) );
    };

    const primed = this.primed;

    delete this.primed;

    if ( primed && primed.offset === offset ) {
      return play( primed.src, this.ac.currentTime, offset, this.trackNode );
    }

    next( 0, offset, this.trackNode );

    return this;
  }

  /**
   * stop all playback
   *
   * @method stop
   *
   * @return {Streamer}
   */

  stop() {
    if ( this.stopped || !this.ready ) {
      return;
    }

    this.stopped = true;
    this.trackNode.disconnect();
    this.trackNode = this.ac.createGain();
    this.trackNode.connect( this.gain );

    const elapsed = this.ac.currentTime - this.startTime;

    this.startTime = null;
    this.startOffset += elapsed;

    // console.info( `stopping ${ this.name } @ ${ this.startOffset }s` );

    if ( this.startOffset >= this.duration ) {
      this.startOffset = 0;
    }

    clearTimeout( this.fetchtimer );
    clearTimeout( this.logtimer );

    return this;
  }

  /**
   * return the current cursor position in seconds
   *
   * @method currentTime
   *
   * @return {Number}    – current playback position in seconds
   */

  currentTime() {
    if ( this.stopped ) {
      return this.startOffset;
    }

    const start   = this.startTime || this.ac.currentTime;
    const offset  = this.startOffset || 0;
    const elapsed = this.ac.currentTime - start;

    return offset + elapsed;
  }

  /**
   * set the current cursor position in seconds
   *
   * @method seek
   * @param  {Number}   offset – offset in seconds
   * @return {Streamer}
   */

  seek( offset ) {
    if ( !this.stopped ) {
      this.stop();
      this.stream( offset );
    } else {
      this.startOffset = offset;
    }
  }

  /**
   * load the audio asset at `this.url`
   *
   * @method load
   *
   * @return {Promise} – resolves with `true`
   */

  async load( force = false ) {

    if ( !force ) {
      // console.info( `checking cache for ${ this.name }` );

      try {
        const { duration } = await this.store.getMetadata( this.name );
        // console.info( `cache hit for ${ this.name }` );
        Object.assign( this, { duration, ready: true } );
        return true;
      } catch {}
    }

    // console.info( `fetching ${ this.url }` );

    return new Promise( ( resolve, reject ) => {
      const xhr = new XMLHttpRequest();

      xhr.open( 'GET', this.url, true );
      xhr.responseType = 'arraybuffer';

      xhr.onload = () => {
        this.ac.decodeAudioData( xhr.response, ab => {
          this.store.saveAudioBuffer( this.name, ab ).then( metadata => {
            this.duration = metadata.duration;
            // console.info( `fetched ${ this.url }` );
            this.ready = true;
            resolve( true );
          }, reject );
        }, reject );
      };

      xhr.onerror = reject;

      xhr.send();
    });
  }

}

class StreamCoordinator {

  /**
   * StreamCoordinator constructor
   *
   * Basically, this sort of *looks* like Streamer in terms of the API,
   * but it actually synchronizes *multiple* streamer instances
   *
   * @method constructor
   *
   * @param  {Array}      urls  – array of audio asset url
   * @param  {AudioStore} store – AudioStore instance
   * @return {StreamCoordinator}
   */

  constructor( urls, store, audioContext, playbackMode ) {
    this.playbackMode = playbackMode;
    this.ac     = audioContext;
    this.store  = store;
    this.urls   = urls;
    this.streamers = [];

    // this.streamers = this.urls.map( url => new Streamer( url, this.store, this.ac ) );

    // throwaway audio buffer
    if (this.playbackMode === "AudioBufferSourceNode") {
      this.garbageBuffer = this.ac.createBuffer( 1, 1, 44100 );
    }

    this.startTime   = null;
    this.startOffset = null;

    this.stopped = true;
    this.ready   = false;
  }

  findStreamer(streamHandle) {
    for (let iStreamer = 0; iStreamer < this.streamers.length; ++iStreamer) {
      const streamer = this.streamers[iStreamer];
        if (streamer.streamID == streamHandle.streamID) {
            return streamer;
        }
    }

    return new Streamer(null, this.store, this.ac); // create dummy
  }

  addClipToStream(streamHandle, clip) {
    console.log("addClipToStream");
    let streamer = this.findStreamer(streamHandle);
    streamer.addClip(clip);
  }

  /**
   * Begin playback at the supplied offset (or resume playback)
   *
   * @method stream
   *
   * @param  {Number} offset – offset in seconds (defaults to 0 or last time )
   * @return {StreamCoordinator}
   */

  stream( offset ) {
    if ( typeof offset !== 'number' ) {
      offset = this.startOffset !== null ? this.startOffset : 0;
    }

    // mobile browsers require the first AudioBuuferSourceNode#start() call
    // to happen in the same call stack as a user interaction.
    //
    // out Promise-based stuff breaks that, so we try to get ourselves onto
    // a good callstack here and play an empty sound if we haven't done
    // so already
    if ( this.garbageBuffer ) {
      const src = this.ac.createBufferSource();
      src.buffer = this.garbageBuffer;
      src.start( 0 );
      delete this.garbageBuffer;
    }

    const promises = this.streamers.map( streamer => streamer.prime( offset ) );

    Promise.all( promises ).then( () => {
      if ( this.startTime === null ) {
        this.startTime = this.ac.currentTime;
      }

      this.streamers.forEach( streamer => streamer.stream( offset ) );
    });

    this.stopped = false;
    this.startOffset = offset;

    return this;
  }

  /**
   * stop all playback
   *
   * @method stop
   *
   * @return {StreamCoordinator}
   */

  stop() {
    if ( this.stopped ) {
      return;
    }

    this.streamers.forEach( streamer => streamer.stop() );

    this.stopped = true;

    const elapsed = this.ac.currentTime - this.startTime;

    this.startTime = null;
    this.startOffset += elapsed;

    if ( this.startOffset >= this.duration ) {
      this.startOffset = 0;
    }
  }

  /**
   * return the current cursor position in seconds
   *
   * @method currentTime
   *
   * @return {Number}    – current playback position in seconds
   */

  currentTime() {
    if ( this.stopped ) {
      return this.startOffset;
    }

    const start   = this.startTime || this.ac.currentTime;
    const offset  = this.startOffset || 0;
    const elapsed = this.ac.currentTime - start;

    const current = offset + elapsed;

    if ( current >= this.duration ) {
      this.stop();
      return 0;
    }

    return current;
  }

  /**
   * set the current cursor position in seconds
   *
   * @method seek
   * @param  {Number}        offset – offset in seconds
   * @return {StreamCoordinator}
   */

  seek( offset ) {
    if ( !this.stopped ) {
      this.stop();
      this.stream( offset );
    } else {
      this.startOffset = offset;
    }
  }

  /**
   * load all audio assets in `this.urls`
   *
   * @method load
   *
   * @return {Promise} – resolves with `true`
   */

  async load() {
    const promises = this.streamers.map( streamer => streamer.load() );

    await Promise.all( promises );

    const durations = this.streamers.map( streamer => streamer.duration );

    this.duration = Math.max.apply( Math, durations );
  }

  /**
   * solo the streamer at the given index (same as the order of `this.urls`)
   *
   * @method solo
   *
   * @param  {Number}        index – streamer index
   * @return {StreamCoordinator}
   */

  solo( index ) {
    this.streamers.forEach( streamer => streamer.gain.gain.value = 0 );
    this.streamers[ index ].gain.gain.value = 1;
  }

  async createStream() {
    console.log("createStream");
    let streamer = null;
    if(this.playbackMode === "AudioWorkletNode") {
      streamer = new AudioWorkletStreamer(null, this.store, this.ac);
      await streamer.initialize(this.ac);
    } else if(this.playbackMode === "AudioBufferSourceNode") {
      streamer = new Streamer(null, this.store, this.ac);
    } else {
      return;
    }

    this.streamers.push(streamer);
    return {streamID: streamer.streamID};
  }

  getNode(streamHandle) {
    let streamer = this.findStreamer(streamHandle);
    return streamer.trackNode;
  }

}
