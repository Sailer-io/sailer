const uniqid = require(`uniqid`)
const git = require(`simple-git/promise`)
const Timer = require(`../timer`)
const config  = require(`../config`).getInstance()
const {exec} = require(`child_process`)
require(`colors`)
const fs = require(`fs`)
const nginxBaseConfig = require(`./nginx-conf`)
const getPort = require(`get-port`)
const util = require(`util`)
const ServiceManager = require(`../services/service-manager`)
const Container = require(`../container`)

/**
 * The main class.
 * It starts a new container, clone the repository and configure Nginx.
 */
module.exports = class Deployer {
  constructor(repo, domain, mustWeSSL, deployPort, relativePath){
    this._deployId = uniqid()
    this._protocol = `https`
    this._repo = repo
    this._folder = null
    this._cloneFolder = `/tmp/${this._deployId}`
    this._relativePath = relativePath
    this._port = null
    this._deployPort = deployPort
    this._domain = domain
    this._mustWeSSL = mustWeSSL
    this.assertDomainIsValid()
    this.parseRepoUrl()
    this._sm = new ServiceManager()
    this._services = null
  }

  /**
   * Launch all needed services
   * @param {Service[]} services 
   */
  async deployServices(services){
    if (services !== undefined){
      this._services = await this._sm.deploy(services)
    }
  }

  /**
   * Verify if the given domain is a valid domain using regex.
   */
  assertDomainIsValid(){
    //eslint-disable-next-line
    const isValid = this._domain.match(`^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}?$`)
    if (isValid === null){
      console.log(`Error, given domain seems erroneous.`)
    }
  }

  /**
   * Used to get the path where the clone files are. It removes trailing slashes.
   * @param {string} path 
   */
  getDockerfileDirectory(path){
    if (this._relativePath === undefined) {
      return path
    }else{
      let dockerFilePath = path
      if ((!this._relativePath.startsWith(`/`) && !path.endsWith(`/`)) || (this._relativePath.startsWith(`/`) && path.endsWith(`/`))){
        dockerFilePath+=`/`
      }
      dockerFilePath+=this._relativePath
      return dockerFilePath
    }
  }

  /**
   * Launch a new or existing deployment.
   * @param {boolean} mustWeSSL (Not used for the moment)
   */
  async deploy(mustWeSSL){ //eslint-disable-line
    Timer.start()
    const existingContainer = await this.verifyIfExists()
    await this.createVolume()
    const cloneUrl = this.getCloneUrl(this._repo)
    //Verify if the given domain exists. If yes, update the deployment, don't create a new one.
    if (existingContainer !== false)
      return this.updateDepoyment(existingContainer, cloneUrl)
    git().silent(true)
      .clone(cloneUrl, this._cloneFolder)
      .then(() => {
        let t = Timer.stop()
        console.log(`Clone done in ${t} ms, building the Docker image. This could take a while...`)
        this.buildImage(this._cloneFolder)
      })
      .catch(() => {
        Timer.stop()
        console.error(`Error, cannot clone given repository.`.red.bold)
        console.error(`Please verify the URL and use the \`login\` command before if needed.`.red.bold)
      })
  }

  /**
   * Update an existing deployment
   * @param {string} uid 
   */
  async updateDepoyment(uid){
    Timer.stop()
    console.log(`Stopping current container...`)
    Timer.start()
    this.getVolumePath(uid).then(path => {
      exec(`docker container stop ${uid}`, () => {
        console.log(`\rDone in ${Timer.stop()} ms.`)
        console.log(`Updating sources...`)
        Timer.start()
        git(path).pull().then(() => {
          console.log(`Done in ${Timer.stop()} ms. Rebuilding Docker image...`)
          this.buildImage(path)
        })
      })
    }) 
  }

  /**
   * Build the Docker Image
   * @param {string} path The path where the Dockerfile is.
   */
  buildImage(path){
    Timer.start()
    const dockerFilePath = this.getDockerfileDirectory(path)
    const services = this.getServices()
    //First, build the image.
    exec(`docker build ${services} -t ${this._deployId} ${dockerFilePath}`, {maxBuffer: 1024 * 5000}, (err) => {
      if (err){
        Timer.stop()
        console.error(`exec error: ${err}`)
        process.exit(1) //eslint-disable-line
      }else{
        console.log(`Build done in ${Timer.stop()} ms.`)
        console.log(`Creating Nginx Config...`)
        Timer.start()
        //Then, update nginx config.
        this.deployNginxConfig().then(() => {
          const t = Timer.stop()
          console.log(`Nginx ready in ${t} ms.`)
          console.log(`Launching container...`)
          Timer.start()
          //Finally, launch the new container
          this.launchContainer().then(() => {
            console.log(`\rNotifying master server...`)
            //Registering new container in database.
            this.registerToDatabase().then(() => {
              Timer.stop()
              console.log(`Container successfully launched!`.green.bold)
              console.log(`Your website was updated from the latest sources.`.green.bold)
            }).catch(() => {
              Timer.stop()
              console.log(`The container is online, but there was an error while contacting the master server.`.yellow.bold)
              console.log(`Please investigate.`.yellow.bold)
            })
          })
        })
      }
    })
  }

  /**
   * Verify if the given domain is attached to an existing container.
   * If yes, update deployement, otherwise, create a new one.
   */
  verifyIfExists(){
    return new Promise((resolve) => {
      const containers = config.get(`data`, `containers`)
      if (containers === null) resolve(false)
      for (let container in containers){
        let domain = containers[container][`domain`]
        if (domain === this._domain){
          return resolve(containers[container][`uid`])
        }
      }
      resolve(false)
    })
  }

  /**
   * Register the new container to the JSON file and to the master server.
   */
  async registerToDatabase(){
    const newContainer = new Container(this._domain, this._deployId, this._repo)
    await newContainer.save()
  }

  /**
   * Start a new Docker container.
   */
  async launchContainer(){
    const services = this.getServices(false)
    const portToPublish = await this.getPortToPublish()
    const workingDir = await this.getWorkingDir()
    exec(`docker container run -dt --restart unless-stopped --name ${this._deployId} -p 127.0.0.1:${this._port}:${portToPublish} -v ${this._deployId}:${workingDir} ${services} ${this._deployId}`)
  }

  /**
   * Get the services string part. Each service has its own network and its own env variables.
   * So each service adds a line like --network myService -e "MYSERVICE_ROOT_PASSWORD=1234"
   * @param {boolean} build The env argument is different while building or launching container.
   */
  getServices(build = true){
    let services = ``
    if (this._services !== null){
      for (let service in this._services){
        let serviceName = service.split(`-`)[1].toUpperCase()
        let variableName = `${serviceName}_root_password`.toUpperCase()
        let envArg = build ? `--build-arg`:`-e`
        services+=`--network ${service} ${envArg} "${variableName}=${this._services[service]}" ${envArg} "${serviceName}_HOSTNAME=${service}" `
      }
      services = services.slice(0,-1)
    }
    return services
  }

  /**
   * Inspect the docker image to know the first published port on the container.
   * Sailer publishes only one port at this time.
   */
  getPortToPublish(){
    return new Promise((resolve) => {
      if (this._deployPort !== null)
        return resolve(this._deployPort)
      exec(`docker image inspect ${this._deployId}`, (err, stdout) => {
        const exposedPorts = JSON.parse(stdout)[0].ContainerConfig.ExposedPorts
        for (let port in exposedPorts){
          return resolve(port.split(`/`)[0])
        }
      })
    })
  }

  /**
   * Get the working directory of the container.
   * Used while updating to copy the directory content.
   */
  getWorkingDir(){
    return new Promise((resolve) => {
      exec(`docker image inspect ${this._deployId}`, (err, stdout) => {
        return resolve(JSON.parse(stdout)[0].ContainerConfig.WorkingDir)
      })
    })
  }

  /**
   * Deploy or update Nginx proxy configuration per host.
   * The config name is my.domain.conf
   */
  async deployNginxConfig(){
    await this.generatePort()
    const nginxConfig = util.format(nginxBaseConfig, 
      this._domain,this._domain,this._domain, this._port)
    fs.writeFileSync(`/etc/nginx/sites-enabled/${this._domain}.conf`, nginxConfig)
    exec(`service nginx reload`)
  }

  /**
   * Get a random port available to link the container and the local host.
   */
  async generatePort(){
    this._port = await getPort()
  }

  /**
   * In the future, used to set letsencrypt automatically.
   */
  async letsencrypt(){
    
  }

  /**
   * Create a Volume. It allows to keep the files between deployments.
   */
  createVolume(){
    return new Promise((resolve) => {
      exec(`docker volume create ${this._deployId}`, () => {
        this.getVolumePath(this._deployId).then(path => {
          this._folder = path
          resolve()
        })
      })
    })
  }

  /**
   * Get the volume path (like /var/docker/...) where the container files are.
   * @param {string} deployId 
   */
  getVolumePath(deployId){
    return new Promise (resolve => {
        exec(`docker volume inspect ${deployId}`, (error, stdout) => {
        const info = JSON.parse(stdout)[0]
        resolve(info.Mountpoint)
      })
    })
  }

  /**
   * If Sailer has credentials for the given Git server, set these credentials in the URL.
   */
  getCloneUrl(){
    const login = this.doesItNeedsAuth()
    if (login === false){
      return `${this._protocol}://${this._repo}`
    }else{
      return `${this._protocol}://${login.username}:${login.token}@${this._repo}`
    }
  }

  /**
   * User can give any Git url like ssh git http or https.
   * We parse the URL to get each time the same URL.
   */
  parseRepoUrl(){
    let goodUrl = this._repo
    if (goodUrl.startsWith(`http://`)){
      goodUrl = goodUrl.substr(7)
      this._protocol = `http`
    }else if (goodUrl.startsWith(`https://`)){
      goodUrl = goodUrl.substr(8)
    }else if (goodUrl.startsWith(`ssh://`) || goodUrl.startsWith(`git://`)){
      goodUrl = goodUrl.substr(6)
    }
    if (goodUrl.endsWith(`.git`)){
      goodUrl = goodUrl.substr(0, goodUrl.length-4)
    }
    const firstIndex = goodUrl.indexOf(`@`)
    if (firstIndex > -1){
      goodUrl = goodUrl.substr(firstIndex+1)
      goodUrl = goodUrl.replace(`:`, `/`)
    }
    this._repo = goodUrl
  }

  /**
   * Search in the .sailer file if the user already did the 'sailer login' command.
   * If yes, returns the token used to login.
   * Used for private repositories.
   */
  doesItNeedsAuth(){
    const tokens = config.get(`tokens`)
    if (this._repo.startsWith(`github.com`) && tokens !== null && tokens.github !== undefined)
      return {username: `sailer`, token: tokens.github}
    if (tokens === null) return false
    for (let t in tokens){
      if (this._repo.startsWith(t)) return tokens[t]
    }
    return false
  }
}


