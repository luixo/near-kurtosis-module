import { NetworkContext, ServiceID, ContainerCreationConfig, ContainerCreationConfigBuilder, ContainerRunConfig, ContainerRunConfigBuilder, StaticFileID, ServiceContext, PortBinding } from "kurtosis-core-api-lib";
import log = require("loglevel");
import { Result, ok, err } from "neverthrow";
import { DOCKER_PORT_PROTOCOL_SEPARATOR, EXEC_COMMAND_SUCCESS_EXIT_CODE, TCP_PROTOCOL, tryToFormHostMachineUrl } from "../consts";
import { ContainerRunConfigSupplier, } from "../near_lambda";

const SERVICE_ID: ServiceID = "contract-helper-service"
const PORT_NUM: number = 3000;
const DOCKER_PORT_DESC: string = PORT_NUM.toString() + DOCKER_PORT_PROTOCOL_SEPARATOR + TCP_PROTOCOL;
// TODO Replace with something published to Dockerhub!!!
const IMAGE: string = "near-contract-helper";
const ACCOUNT_CREATOR_KEY_ENVVAR: string = "ACCOUNT_CREATOR_KEY";
// INDEXER_DB_CONNECTION=postgres://<user>:<password>@<domain>/near_indexer_for_wallet_testnet?ssl=require
const INDEXER_DB_CONNECTION_ENVVAR: string = "INDEXER_DB_CONNECTION";
// NODE_URL=http://0.0.0.0:3030 # from ~/.near/config.json#rpc.addr – for production, use https://rpc.testnet.near.org
const NODE_RPC_URL_ENVVAR: string = "NODE_URL";
const STATIC_ENVVARS: Map<string, string> = new Map(Object.entries({
    "MAIL_HOST": "smtp.ethereal.email",
    "MAIL_PASSWORD": "",
    "MAIL_PORT": "587",
    "MAIL_USER": "",
    "NEW_ACCOUNT_AMOUNT": "10000000000000000000000000",
    "NODE_ENV": "development", // Node.js environment; either `development` or `production`
    "PORT": PORT_NUM.toString(), // Used internally by the contract helper; does not have to correspond to the external IP or DNS name and can link to a host machine running the Docker container
    "TWILIO_ACCOUNT_SID": "", // account SID from Twilio (used to send security code)
    "TWILIO_AUTH_TOKEN": "", // auth token from Twilio (used to send security code)
    "TWILIO_FROM_PHONE": "+14086179592", // phone number from which to send SMS with security code (international format, starting with `+`)
    // NOTE: We can't set this because there's a circular dependency between Wallet and Contract Helper app, where
    //  they both need to point to each others' _publicly-facing ports_ (which are only available after starting the container)
    // Following the lead of https://github.com/near/local/blob/master/docker-compose.yml, we're choosing to break Contract Helper app
    "WALLET_URL": "" // NOTE: we can't set this because there's a circular dependency between 
}));

export class ContractHelperServiceInfo {
    private readonly networkInternalHostname: string;
    private readonly networkInternalPorNum: number;
    // Will only be set if debug mode is enabled
    private readonly maybeHostMachinePortBinding: PortBinding | undefined;

    constructor(
        networkInternalHostname: string,
        networkInternalPorNum: number,
        maybeHostMachinePortBinding: PortBinding | undefined,
    ) {
        this.networkInternalHostname = networkInternalHostname;
        this.networkInternalPorNum = networkInternalPorNum;
        this.maybeHostMachinePortBinding = maybeHostMachinePortBinding;
    }

    public getNetworkInternalHostname(): string {
        return this.networkInternalHostname;
    }

    public getNetworkInternalPortNum(): number {
        return this.networkInternalPorNum;
    }

    public getMaybeHostMachinePortBinding(): PortBinding | undefined {
        return this.maybeHostMachinePortBinding;
    }
}

export async function addContractHelperService(
    networkCtx: NetworkContext,
    contractHelperDbHostname: string,
    contractHelperDbPortNum: number,
    contractHelperDbUsername: string,
    contractHelperDbUserPassword: string,
    nearupHostname: string,
    nearupPort: number,
    validatorKey: string,   // Created in the Nearup service
): Promise<Result<ContractHelperServiceInfo, Error>> {
    log.info(`Adding contract helper service running on port '${DOCKER_PORT_DESC}'`);
    const usedPortsSet: Set<string> = new Set();
    usedPortsSet.add(DOCKER_PORT_DESC)
    const containerCreationConfig: ContainerCreationConfig = new ContainerCreationConfigBuilder(
        IMAGE,
    ).withUsedPorts(
        usedPortsSet
    ).build();

    const envvars: Map<string, string> = new Map();
    envvars.set(
        ACCOUNT_CREATOR_KEY_ENVVAR,
        validatorKey
    )
    envvars.set(
        INDEXER_DB_CONNECTION_ENVVAR,
        `postgres://${contractHelperDbUsername}:${contractHelperDbUserPassword}@${contractHelperDbHostname}:${contractHelperDbPortNum}/near_indexer_for_wallet_testnet?ssl=require`
    )
    envvars.set(
        NODE_RPC_URL_ENVVAR,
        `http://${nearupHostname}:${nearupPort}`
    )
    for (let [key, value] of STATIC_ENVVARS.entries()) {
        envvars.set(key, value);
    }
    const containerRunConfigSupplier: ContainerRunConfigSupplier = (ipAddr: string, generatedFileFilepaths: Map<string, string>, staticFileFilepaths: Map<StaticFileID, string>) => {
        const result: ContainerRunConfig = new ContainerRunConfigBuilder().withEnvironmentVariableOverrides(
            envvars
        ).build();
        return ok(result);
    }
    
    const addServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await networkCtx.addService(SERVICE_ID, containerCreationConfig, containerRunConfigSupplier);
    if (addServiceResult.isErr()) {
        return err(addServiceResult.error);
    }
    const [serviceCtx, hostMachinePortBindings]: [ServiceContext, Map<string, PortBinding>] = addServiceResult.value;

    const result: ContractHelperServiceInfo = new ContractHelperServiceInfo(
        SERVICE_ID,
        PORT_NUM,
        hostMachinePortBindings.get(DOCKER_PORT_DESC)
    );

    return ok(result);
}
