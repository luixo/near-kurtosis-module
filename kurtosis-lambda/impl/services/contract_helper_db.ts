import { NetworkContext, ServiceID, ContainerConfig, ContainerConfigBuilder, SharedPath, ServiceContext, PortBinding } from "kurtosis-core-api-lib";
import log from "loglevel";
import { Result, ok, err } from "neverthrow";
import { DOCKER_PORT_PROTOCOL_SEPARATOR, EXEC_COMMAND_SUCCESS_EXIT_CODE, TCP_PROTOCOL } from "../consts";
// import { promises as fsPromises } from "fs";

const SERVICE_ID: ServiceID = "contract-helper-db";
const IMAGE: string = "postgres:13.4-alpine3.14";
const PORT_NUM: number = 5432;
const DOCKER_PORT_DESC: string = PORT_NUM.toString() + DOCKER_PORT_PROTOCOL_SEPARATOR + TCP_PROTOCOL;
const POSTGRES_USER: string = "near";
const POSTGRES_PASSWORD: string = "near";
const STATIC_ENVVARS: Map<string, string> = new Map(Object.entries({
    "POSTGRES_USER": POSTGRES_USER,
    "POSTGRES_PASSWORD": POSTGRES_PASSWORD,
}));

/*
// const CONTRACT_HELPER_DB_INITIALIZATION_FILE_ID: StaticFileID = "contract-helper-db-initializer"
// const INDEXER_DB_INITIALIZATION_FILE_ID: StaticFileID = "indexer-db-initializer"
const INDEXER_DB_INITIALIZATION_FILENAME: string = "indexer-db.sql"
// Mapping of static filepaths on the Lambda container -> relative filepath inside the shared dir
const STATIC_FILE_RELATIVE_FILEPATHS_IN_SHARED_DIR: Map<string, string> = new Map([
    // [CONTRACT_HELPER_DB_INITIALIZATION_FILE_ID, "/static-files/contract-helper-db.sql"],
    ["/static-files/" + INDEXER_DB_INITIALIZATION_FILENAME, INDEXER_DB_INITIALIZATION_FILENAME],
]);
*/
// const CONTRACT_HELPER_DB: string = "accounts_development";
const INDEXER_DB: string = "indexer";
// Mapping of DB to initialize -> relative filepath within shared dir of the file to intiialize it
const DBS_TO_INITIALIZE: Set<string> = new Set([
    INDEXER_DB,
])
/*
const PER_DB_INITIALIZER_RELATIVE_FILEPATHS: Map<string, string> = new Map([
    // [CONTRACT_HELPER_DB, CONTRACT_HELPER_DB_INITIALIZATION_FILE_ID], 
    [INDEXER_DB, INDEXER_DB_INITIALIZATION_FILENAME]
])
*/
const MAX_AVAILABILITY_CHECK_RETRIES: number = 10;
const MILLIS_BETWEEN_AVAILABILITY_CHECK_RETRIES: number = 1000;
const AVAILABILITY_CMD: string[] = [
    "psql",
    "-U",
    POSTGRES_USER,
    "-c",
    "\\l"
];

// const DB_INITIALIZATION_SQL_FILE_ID: StaticFileID = "contract-helper-initialization-sql"
const DB_INITIALIZATION_SQL_FILEPATH_ON_LAMBDA_CONTAINER: string = "/static-files/contract-helper-db.sql";

export class ContractHelperDbInfo {
    private readonly networkInternalHostname: string;
    private readonly networkInternalPortNum: number;
    private readonly dbUsername: string;
    private readonly dbUserPassword: string;
    // private readonly contractHelperDb: string;
    private readonly indexerDb: string;

    constructor(
        networkInternalHostname: string,
        networkInternalPortNum: number,
        dbUsername: string,
        dbUserPassword: string,
        // contractHelperDb: string,
        indexerDb: string
    ) {
        this.networkInternalHostname = networkInternalHostname;
        this.networkInternalPortNum = networkInternalPortNum;
        this.dbUsername = dbUsername;
        this.dbUserPassword = dbUserPassword;
        // this.contractHelperDb = contractHelperDb;
        this.indexerDb = indexerDb;
    }

    public getNetworkInternalHostname(): string {
        return this.networkInternalHostname;
    }

    public getNetworkInternalPortNum(): number {
        return this.networkInternalPortNum;
    }

    public getDbUsername(): string {
        return this.dbUsername;
    }

    public getDbPassword(): string {
        return this.dbUserPassword;
    }

    /*
    public getContractHelperDb(): string {
        return this.contractHelperDb;
    }
    */

    public getIndexerDb(): string {
        return this.indexerDb;
    }
}

export async function addContractHelperDb(networkCtx: NetworkContext): Promise<Result<ContractHelperDbInfo, Error>> {
    /*
    // TODO Make working with static files wayyyyyy better!!!!
    const registerStaticFilesResult: Result<null, Error> = await networkCtx.registerStaticFiles(STATIC_FILEPATHS_ON_THIS_CONTAINER)
    if (registerStaticFilesResult.isErr()) {
        return err(registerStaticFilesResult.error);
    }
    */

    log.info("Adding contract helper DB running on port '" + DOCKER_PORT_DESC + "'");
    const usedPortsSet: Set<string> = new Set();
    usedPortsSet.add(DOCKER_PORT_DESC)
    const containerConfigSupplier: (ipAddr: string, sharedDirpath: SharedPath) => Result<ContainerConfig, Error> = (ipAddr: string, sharedDirpath: SharedPath): Result<ContainerConfig, Error> => {
        /*
        // Copy DB initialization files
        for (let [absFilepathOnThisContainer, relativeFilepathInSharedDir] of STATIC_FILE_RELATIVE_FILEPATHS_IN_SHARED_DIR.entries()) {
            const sharedPath: SharedPath = sharedDirpath.GetChildPath(relativeFilepathInSharedDir)
            const absFilepathOnServiceContainer: string = sharedPath.getAbsPathOnServiceContainer();
            try {
                await fsPromises.copyFile(absFilepathOnThisContainer, absFilepathOnServiceContainer)
            } catch (e) {
                return err(e);
            }
        }
        */

        const result: ContainerConfig = new ContainerConfigBuilder(IMAGE).withUsedPorts(
            usedPortsSet
        ).withEnvironmentVariableOverrides(
            STATIC_ENVVARS
        ).build();
        return ok(result);
    }
    
    const addServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await networkCtx.addService(SERVICE_ID, containerConfigSupplier);
    if (addServiceResult.isErr()) {
        return err(addServiceResult.error);
    }
    const [serviceCtx, hostPortBindings]: [ServiceContext, Map<string, PortBinding>] = addServiceResult.value;

    const waitForAvailabilityResult: Result<null, Error> = await waitForContractHelperDbToBecomeAvailable(serviceCtx);
    if (waitForAvailabilityResult.isErr()) {
        return err(waitForAvailabilityResult.error);
    }

    const sharedDir: SharedPath = serviceCtx.getSharedDirectory();




    for (const databaseToCreate of DBS_TO_INITIALIZE) {
        // Create the database inside of Postgres
        const createDbCmd: string[] = [
            "psql",
            "-U",
            POSTGRES_USER,
            "-c",
            "create database " + databaseToCreate + " with owner=" + POSTGRES_USER
        ];
        const createDatabaseResult: Result<[number, string], Error> = await serviceCtx.execCommand(createDbCmd);
        if (createDatabaseResult.isErr()) {
            return err(createDatabaseResult.error);
        }
        const [createDbExitCode, createDbLogOutput]: [number, string] = createDatabaseResult.value;
        if (createDbExitCode !== EXEC_COMMAND_SUCCESS_EXIT_CODE) {
            return err(new Error(
                `Command to create database '${createDbCmd.join(" ")}' returned error exit code '${createDbExitCode}' with logs:\n${createDbLogOutput}`
            ));
        }

        // TODO remove???

        /*
        // Next, populate it with data
        const maybeInitializationSqlFilepathOnSvc: string | undefined = staticFileFilepathsOnSvc.get(initializerStaticFileId);
        if (maybeInitializationSqlFilepathOnSvc === undefined) {
            return err(new Error(
                `Static file ID '${initializerStaticFileId}' for database '${database}' doesn't have a filepath on the service; this is VERY weird!`
            ));
        }
        const initializationSqlFilepathOnSvc: string = maybeInitializationSqlFilepathOnSvc;

        const initializeDbCmd: string[] = [
            "sh",
            "-c",
            "cat " + initializationSqlFilepathOnSvc + " | psql -U " + POSTGRES_USER + " -d " + database
        ];
        const initializeDbResult: Result<[number, string], Error> = await serviceCtx.execCommand(initializeDbCmd);
        if (initializeDbResult.isErr()) {
            return err(initializeDbResult.error);
        }
        const [initializeDbExitCode, initializeDbLogOutput]: [number, string] = initializeDbResult.value;
        if (initializeDbExitCode !== EXEC_COMMAND_SUCCESS_EXIT_CODE) {
            return err(new Error(
                `Command '${initializeDbCmd.join(" ")}' to initialize database '${database}' returned error exit code '${initializeDbExitCode}' with logs:\n${initializeDbLogOutput}`
            ));
        }
        */
    }


    const result: ContractHelperDbInfo = new ContractHelperDbInfo(
        SERVICE_ID,
        PORT_NUM,
        POSTGRES_USER,
        POSTGRES_PASSWORD,
        // CONTRACT_HELPER_DB,
        INDEXER_DB,
    );

    return ok(result);
}

async function waitForContractHelperDbToBecomeAvailable(serviceCtx: ServiceContext): Promise<Result<null, Error>> {
    for (let i: number = 0; i < MAX_AVAILABILITY_CHECK_RETRIES; i++) {
        const execCmdResult: Result<[number, string], Error> = await serviceCtx.execCommand(AVAILABILITY_CMD);
        if (execCmdResult.isOk()) {
            const [exitCode, logOutput] = execCmdResult.value;
            if (exitCode == EXEC_COMMAND_SUCCESS_EXIT_CODE) {
                return ok(null);
            }
            log.debug("Contract helper DB availability command '" + AVAILABILITY_CMD + "' exited with code " + exitCode.toString() + " and logs:\n" + logOutput);
        } else {
            log.debug("Contract helper DB availability command '" + AVAILABILITY_CMD + "' returned error:\n" + execCmdResult.error);
        }
        await new Promise(resolve => setTimeout(resolve, MILLIS_BETWEEN_AVAILABILITY_CHECK_RETRIES));
    }
    return err(new Error(
        "Contract helper DB didn't become available even after " + MAX_AVAILABILITY_CHECK_RETRIES + " retries with " + MILLIS_BETWEEN_AVAILABILITY_CHECK_RETRIES + "ms between retries"
    ));
}