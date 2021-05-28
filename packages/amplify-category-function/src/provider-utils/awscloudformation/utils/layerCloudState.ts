import { $TSContext, exitOnNextTick } from 'amplify-cli-core';
import ora from 'ora';
import { LayerCfnLogicalNamePrefix } from './constants';
import { isMultiEnvLayer } from './layerHelpers';
import { LegacyPermissionEnum } from './layerMigrationUtils';
import { LayerVersionMetadata, PermissionEnum } from './layerParams';

export class LayerCloudState {
  private static instance: LayerCloudState;
  private layerVersionsMetadata: LayerVersionMetadata[];
  public latestVersionLogicalId: string;

  static getInstance(): LayerCloudState {
    if (!LayerCloudState.instance) {
      LayerCloudState.instance = new LayerCloudState();
    }
    return LayerCloudState.instance;
  }

  private async loadLayerDataFromCloud(context: $TSContext, layerName: string): Promise<LayerVersionMetadata[]> {
    const spinner = ora('Loading layer data from the cloud...').start();
    let layerMetadata: LayerVersionMetadata[];
    try {
      const { envName }: { envName: string } = context.amplify.getEnvInfo();
      const providerPlugin = await import(context.amplify.getProviderPlugins(context).awscloudformation);
      const Lambda = await providerPlugin.getLambdaSdk(context);
      const layerVersionList = await Lambda.listLayerVersions(isMultiEnvLayer(layerName) ? `${layerName}-${envName}` : layerName);
      const Cfn = await providerPlugin.getCloudFormationSdk(context);
      const stackList = await Cfn.listStackResources();
      const layerStacks = stackList?.StackResourceSummaries?.filter(stack => stack.LogicalResourceId.includes(layerName));
      let detailedLayerStack;

      if (layerStacks?.length > 0) {
        detailedLayerStack = (await Cfn.listStackResources(layerStacks[0].PhysicalResourceId)).StackResourceSummaries;
      } else {
        spinner.stop();
        return [];
      }

      layerVersionList.forEach((layerVersion: LayerVersionMetadata) => {
        let layerLogicalIdSuffix: string;
        detailedLayerStack
          .filter(stack => stack.ResourceType === 'AWS::Lambda::LayerVersion' && stack.PhysicalResourceId === layerVersion.LayerVersionArn)
          .forEach(stack => {
            layerVersion.LogicalName = stack.LogicalResourceId;
            layerLogicalIdSuffix = stack.LogicalResourceId.replace(LayerCfnLogicalNamePrefix.LambdaLayerVersion, '');
          });

        detailedLayerStack
          .filter(
            stack =>
              stack.ResourceType === 'AWS::Lambda::LayerVersionPermission' &&
              stack.PhysicalResourceId.split('#')[0] === layerVersion.LayerVersionArn,
          )
          .forEach(stack => {
            layerVersion.permissions = layerVersion.permissions || [];

            const permissionTypeString = stack.LogicalResourceId.replace(
              LayerCfnLogicalNamePrefix.LambdaLayerVersionPermission,
              '',
            ).replace(layerLogicalIdSuffix, '');

            const accountIds = [];
            const orgIds = [];
            if (permissionTypeString === PermissionEnum.Private || permissionTypeString.startsWith(LegacyPermissionEnum.Private)) {
              layerVersion.permissions.push({ type: PermissionEnum.Private });
            } else if (permissionTypeString === PermissionEnum.Public || permissionTypeString.startsWith(LegacyPermissionEnum.Public)) {
              layerVersion.permissions.push({ type: PermissionEnum.Public });
            } else if (permissionTypeString.startsWith(PermissionEnum.AwsAccounts)) {
              accountIds.push(permissionTypeString.replace(PermissionEnum.AwsAccounts, '').replace(`Legacy${layerVersion.Version}`, ''));
            } else if (permissionTypeString.startsWith(LegacyPermissionEnum.AwsAccounts)) {
              accountIds.push(permissionTypeString.replace(LegacyPermissionEnum.AwsAccounts, '').substring(0, 12));
            } else if (permissionTypeString.startsWith(PermissionEnum.AwsOrg)) {
              const orgId = permissionTypeString.replace(`${PermissionEnum.AwsOrg}o`, 'o-').replace(`Legacy${layerVersion.Version}`, '');
              orgIds.push(orgId);
            } else if (permissionTypeString.startsWith(LegacyPermissionEnum.AwsOrg)) {
              const suffix = `${layerVersion.Version}`;
              const orgId = permissionTypeString.replace(`${LegacyPermissionEnum.AwsOrg}o`, 'o-').slice(0, -1 * suffix.length);
              orgIds.push(orgId);
            }

            if (accountIds.length > 0) {
              layerVersion.permissions.push({
                type: PermissionEnum.AwsAccounts,
                accounts: accountIds,
              });
            }
            if (orgIds.length > 0) {
              layerVersion.permissions.push({
                type: PermissionEnum.AwsOrg,
                orgs: orgIds,
              });
            }
          });

        layerVersion.legacyLayer = layerVersion.LogicalName === undefined || layerVersion.LogicalName === 'LambdaLayer';
      });
      layerMetadata = layerVersionList.sort((a: LayerVersionMetadata, b: LayerVersionMetadata) => b.Version - a.Version);
    } catch (e) {
      spinner.fail();
      const errMessage = `An error occurred fetching the latest layer version metadata for "${layerName}": ${e.message || e}`;
      context.print.error(errMessage);
      await context.usageData.emitError(new Error(errMessage));
      exitOnNextTick(1);
    }
    spinner.stop();
    return layerMetadata;
  }

  public async getLayerVersionsFromCloud(context: $TSContext, layerName: string): Promise<LayerVersionMetadata[]> {
    if (this.layerVersionsMetadata) {
      return this.layerVersionsMetadata;
    }
    return this.loadLayerDataFromCloud(context, layerName);
  }
}
