# usage: dvpc.sh <region> <check|delete>
r=$1; mode=$2; A="aws --region $r --output text"
v=$($A ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId')
[ "$v" = "None" -o -z "$v" ] && { echo "$r no-default-vpc"; exit 0; }
eni=$($A ec2 describe-network-interfaces --filters Name=vpc-id,Values=$v --query 'length(NetworkInterfaces)')
ins=$($A ec2 describe-instances --filters Name=vpc-id,Values=$v Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations)')
sg=$($A ec2 describe-security-groups --filters Name=vpc-id,Values=$v --query 'length(SecurityGroups[?GroupName!=`default`])')
ep=$($A ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=$v --query 'length(VpcEndpoints)')
nat=$($A ec2 describe-nat-gateways --filter Name=vpc-id,Values=$v Name=state,Values=available,pending --query 'length(NatGateways)')
peer=$($A ec2 describe-vpc-peering-connections --filters Name=requester-vpc-info.vpc-id,Values=$v --query 'length(VpcPeeringConnections)')
echo "$r $v eni=$eni inst=$ins sg=$sg ep=$ep nat=$nat peer=$peer"
[ "$mode" = delete ] || exit 0
if [ "$eni$ins$sg$ep$nat$peer" != "000000" ]; then echo "$r SKIP: not empty"; exit 0; fi
for i in $($A ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=$v --query 'InternetGateways[].InternetGatewayId'); do aws --region $r ec2 detach-internet-gateway --internet-gateway-id $i --vpc-id $v; aws --region $r ec2 delete-internet-gateway --internet-gateway-id $i; done
for s in $($A ec2 describe-subnets --filters Name=vpc-id,Values=$v --query 'Subnets[].SubnetId'); do aws --region $r ec2 delete-subnet --subnet-id $s; done
aws --region $r ec2 delete-vpc --vpc-id $v && echo "$r DELETED $v"
