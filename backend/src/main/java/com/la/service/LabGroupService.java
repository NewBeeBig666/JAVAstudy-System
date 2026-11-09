package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.Assignment;
import com.la.entity.ClassEntity;
import com.la.entity.LabGroup;
import com.la.entity.LabGroupInvite;
import com.la.entity.LabGroupMember;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.AssignmentMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.LabGroupInviteMapper;
import com.la.mapper.LabGroupMapper;
import com.la.mapper.LabGroupMemberMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.Collectors;

/**
 * 实验报告作业「分组实验」：随机分组（发布时系统生成）/ 学生自行组队（邀请制）。
 *
 * 自行组队规则（与需求一一对应）：
 * - 发起邀请的学生自动成为队长（首邀时建组并写入本人组员记录）；
 * - 已发起组队邀请、已成为任何队伍成员（含队长）的学生，不可再被邀请
 *   （首邀即建组入组，因此「组员表无记录」即等价于「未发起过邀请且不在任何队伍」）；
 * - 学生可同时收到多个邀请；接受任意一个后立即入组（唯一键兜底并发），
 *   其余待响应邀请自动置为 EXPIRED。
 */
@Service
@RequiredArgsConstructor
public class LabGroupService {

    private final LabGroupMapper labGroupMapper;
    private final LabGroupMemberMapper labGroupMemberMapper;
    private final LabGroupInviteMapper labGroupInviteMapper;
    private final AssignmentMapper assignmentMapper;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final NotificationService notificationService;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /* ==================== 配置解析 ==================== */

    /**
     * 从作业 description JSON 解析分组配置。
     * 返回 {mode: RANDOM|SELF, count: int}；未开启 / 缺字段 / 解析失败返回 null。
     */
    public static Map<String, Object> parseGroupConfig(String description) {
        if (description == null || description.isBlank()) {
            return null;
        }
        try {
            JsonNode g = MAPPER.readTree(description).path("group");
            if (!g.isObject() || !g.path("enabled").asBoolean(false)) {
                return null;
            }
            String mode = g.path("mode").asText("");
            int count = g.path("count").asInt(0);
            if ((!"RANDOM".equals(mode) && !"SELF".equals(mode)) || count < 1) {
                return null;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("mode", mode);
            m.put("count", count);
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    /** 该作业是否已产生任何分组数据（小组/组员/邀请） */
    public boolean hasGroupData(Long assignmentId) {
        Long cnt = labGroupMapper.selectCount(new LambdaQueryWrapper<LabGroup>()
                .eq(LabGroup::getAssignmentId, assignmentId));
        return cnt != null && cnt > 0;
    }

    /** 删除作业时级联清理分组数据 */
    @Transactional
    public void deleteGroupData(Long assignmentId) {
        labGroupInviteMapper.delete(new LambdaQueryWrapper<LabGroupInvite>()
                .eq(LabGroupInvite::getAssignmentId, assignmentId));
        labGroupMemberMapper.delete(new LambdaQueryWrapper<LabGroupMember>()
                .eq(LabGroupMember::getAssignmentId, assignmentId));
        labGroupMapper.delete(new LambdaQueryWrapper<LabGroup>()
                .eq(LabGroup::getAssignmentId, assignmentId));
    }

    /* ==================== 随机分组（发布时生成） ==================== */

    /**
     * 随机分组：全班人数 ÷ 组数均衡分配（前 remainder 组多 1 人），组员随机组合，
     * 每组随机指定 1 名组长。已有分组数据时不重复生成（幂等）。
     * 边界：班级无学生 / 组数超过人数 → 明确报错。
     */
    @Transactional
    public void generateRandomGroups(Assignment as, int groupCount) {
        Long existing = labGroupMapper.selectCount(new LambdaQueryWrapper<LabGroup>()
                .eq(LabGroup::getAssignmentId, as.getId()));
        if (existing != null && existing > 0) {
            return;
        }
        List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, as.getClassId()).eq(User::getRole, "STUDENT"));
        if (students.isEmpty()) {
            throw new BizException("班级暂无学生，无法随机分组");
        }
        if (groupCount > students.size()) {
            throw new BizException("分组数量（" + groupCount + "）超过班级学生人数（"
                    + students.size() + "），请调整分组数量后重试");
        }
        List<User> shuffled = new ArrayList<>(students);
        java.util.Collections.shuffle(shuffled);
        int n = shuffled.size();
        int base = n / groupCount;
        int remainder = n % groupCount;
        int idx = 0;
        for (int g = 0; g < groupCount; g++) {
            int size = base + (g < remainder ? 1 : 0);
            List<User> members = shuffled.subList(idx, idx + size);
            idx += size;
            User leader = members.get(ThreadLocalRandom.current().nextInt(size));
            LabGroup grp = new LabGroup();
            grp.setAssignmentId(as.getId());
            grp.setSeq(g + 1);
            grp.setName("第" + (g + 1) + "组");
            grp.setLeaderStudentId(leader.getId());
            grp.setCreatedAt(LocalDateTime.now());
            labGroupMapper.insert(grp);
            for (User u : members) {
                labGroupMemberMapper.insert(memberOf(grp.getId(), as.getId(), u.getId()));
            }
        }
    }

    /* ==================== 教师端：分组全景 ==================== */

    /** 教师查看作业下全部小组组建状态与成员构成（前端轮询实现实时同步） */
    public Map<String, Object> teacherGroups(Long teacherId, Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null) {
            throw new BizException("作业不存在");
        }
        List<Long> ownClassIds = classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList();
        if (!ownClassIds.isEmpty() && !ownClassIds.contains(as.getClassId())) {
            throw new BizException("无权查看该作业");
        }
        Map<String, Object> cfg = requireGroupConfig(as);
        boolean selfMode = "SELF".equals(cfg.get("mode"));
        int groupCount = ((Number) cfg.get("count")).intValue();

        List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, as.getClassId()).eq(User::getRole, "STUDENT"));
        Map<Long, User> uMap = students.stream()
                .collect(Collectors.toMap(User::getId, u -> u));
        List<LabGroupMember> members = labGroupMemberMapper.selectList(
                new LambdaQueryWrapper<LabGroupMember>()
                        .eq(LabGroupMember::getAssignmentId, assignmentId));
        Map<Long, List<LabGroupMember>> byGroup = members.stream()
                .collect(Collectors.groupingBy(LabGroupMember::getGroupId));
        Set<Long> groupedIds = members.stream()
                .map(LabGroupMember::getStudentId).collect(Collectors.toSet());
        List<LabGroup> groups = labGroupMapper.selectList(new LambdaQueryWrapper<LabGroup>()
                .eq(LabGroup::getAssignmentId, assignmentId).orderByAsc(LabGroup::getSeq));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mode", selfMode ? "self" : "random");
        result.put("groupCount", groupCount);
        result.put("classSize", students.size());
        result.put("cap", capOf(students.size(), groupCount));
        result.put("groupedCount", groupedIds.size());
        result.put("groups", groups.stream()
                .map(g -> groupDto(g, byGroup.getOrDefault(g.getId(), List.of()), uMap))
                .collect(Collectors.toList()));
        result.put("ungrouped", students.stream()
                .filter(u -> !groupedIds.contains(u.getId()))
                .map(u -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", String.valueOf(u.getId()));
                    m.put("name", u.getRealName());
                    return m;
                }).collect(Collectors.toList()));
        if (selfMode) {
            List<LabGroupInvite> pending = labGroupInviteMapper.selectList(
                    new LambdaQueryWrapper<LabGroupInvite>()
                            .eq(LabGroupInvite::getAssignmentId, assignmentId)
                            .eq(LabGroupInvite::getStatus, "PENDING")
                            .orderByAsc(LabGroupInvite::getId));
            result.put("invites", pending.stream().map(inv -> {
                User from = uMap.get(inv.getFromStudentId());
                User to = uMap.get(inv.getToStudentId());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", String.valueOf(inv.getId()));
                m.put("fromName", from != null ? from.getRealName() : "已离班学生");
                m.put("toName", to != null ? to.getRealName() : "已离班学生");
                return m;
            }).collect(Collectors.toList()));
        }
        return result;
    }

    /* ==================== 学生端：我的分组 / 组队 ==================== */

    /** 学生查看本作业分组信息：所在小组（成员+组长标注）/ 收到的邀请 / 可邀请同学 */
    public Map<String, Object> myGroup(Long studentId, Long assignmentId) {
        Assignment as = labAssignment(assignmentId);
        requireStudentOfClass(studentId, as);
        Map<String, Object> cfg = requireGroupConfig(as);
        boolean selfMode = "SELF".equals(cfg.get("mode"));
        int groupCount = ((Number) cfg.get("count")).intValue();

        List<User> classmates = userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, as.getClassId()).eq(User::getRole, "STUDENT"));
        Map<Long, User> uMap = classmates.stream()
                .collect(Collectors.toMap(User::getId, u -> u));
        List<LabGroupMember> members = labGroupMemberMapper.selectList(
                new LambdaQueryWrapper<LabGroupMember>()
                        .eq(LabGroupMember::getAssignmentId, assignmentId));
        Map<Long, List<LabGroupMember>> byGroup = members.stream()
                .collect(Collectors.groupingBy(LabGroupMember::getGroupId));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mode", selfMode ? "self" : "random");
        result.put("groupCount", groupCount);
        result.put("classSize", classmates.size());
        if (selfMode) {
            result.put("cap", capOf(classmates.size(), groupCount));
        }

        LabGroupMember mine = members.stream()
                .filter(x -> x.getStudentId().equals(studentId)).findFirst().orElse(null);
        if (mine != null) {
            LabGroup grp = labGroupMapper.selectById(mine.getGroupId());
            if (grp != null) {
                result.put("myGroup", groupDto(grp, byGroup.getOrDefault(grp.getId(), List.of()), uMap));
                result.put("isLeader", grp.getLeaderStudentId().equals(studentId));
            }
        }
        if (!result.containsKey("myGroup")) {
            result.put("myGroup", null);
            result.put("isLeader", false);
        }

        if (selfMode) {
            // 收到的待响应邀请（可同时多个）
            List<LabGroupInvite> received = labGroupInviteMapper.selectList(
                    new LambdaQueryWrapper<LabGroupInvite>()
                            .eq(LabGroupInvite::getAssignmentId, assignmentId)
                            .eq(LabGroupInvite::getToStudentId, studentId)
                            .eq(LabGroupInvite::getStatus, "PENDING")
                            .orderByAsc(LabGroupInvite::getId));
            result.put("invites", received.stream().map(inv -> {
                User from = uMap.get(inv.getFromStudentId());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", String.valueOf(inv.getId()));
                m.put("fromId", String.valueOf(inv.getFromStudentId()));
                m.put("fromName", from != null ? from.getRealName() : "已离班学生");
                return m;
            }).collect(Collectors.toList()));

            // 我发出的邀请（含状态：待响应/已加入/已婉拒/已失效）
            List<LabGroupInvite> sent = labGroupInviteMapper.selectList(
                    new LambdaQueryWrapper<LabGroupInvite>()
                            .eq(LabGroupInvite::getAssignmentId, assignmentId)
                            .eq(LabGroupInvite::getFromStudentId, studentId)
                            .orderByDesc(LabGroupInvite::getId));
            result.put("sentInvites", sent.stream().map(inv -> {
                User to = uMap.get(inv.getToStudentId());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", String.valueOf(inv.getId()));
                m.put("toId", String.valueOf(inv.getToStudentId()));
                m.put("toName", to != null ? to.getRealName() : "已离班学生");
                m.put("status", inv.getStatus() == null ? "" : inv.getStatus().toLowerCase());
                return m;
            }).collect(Collectors.toList()));

            // 可邀请同学 = 本班且不属于任何队伍（发起过组队的人已是队长，天然排除）
            Set<Long> groupedIds = members.stream()
                    .map(LabGroupMember::getStudentId).collect(Collectors.toSet());
            result.put("invitable", classmates.stream()
                    .filter(u -> !u.getId().equals(studentId) && !groupedIds.contains(u.getId()))
                    .map(u -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("id", String.valueOf(u.getId()));
                        m.put("name", u.getRealName());
                        return m;
                    }).collect(Collectors.toList()));
        }
        return result;
    }

    /**
     * 学生邀请同学组队（自行组队模式）：
     * - 首次邀请自动建组，发起者成为队长并入组；
     * - 已在某队伍时仅队长可继续邀人；被邀请人须不属于任何队伍（含已发起过组队的队长）；
     * - 同一对 (from, to) 只允许发起一次邀请（含被拒绝后，防重复骚扰）；
     * - 队伍满员（上限 = ⌈班级人数 / 分组数量⌉）不可再邀。
     */
    @Transactional
    public Map<String, Object> invite(Long studentId, Long assignmentId, Long toStudentId) {
        Assignment as = selfTeamAssignment(assignmentId);
        User me = requireStudentOfClass(studentId, as);
        if (toStudentId == null || toStudentId.equals(studentId)) {
            throw new BizException("不能邀请自己组队");
        }
        User target = userMapper.selectById(toStudentId);
        if (target == null || !"STUDENT".equals(target.getRole())
                || !as.getClassId().equals(target.getClassId())) {
            throw new BizException("被邀请的同学不存在或不在本班");
        }

        // 我的队伍：已有队伍必须是队长（首邀自动建组），否则新建
        LabGroupMember mine = memberOf(assignmentId, studentId);
        LabGroup group;
        boolean created = false;
        if (mine != null) {
            group = labGroupMapper.selectByIdForUpdate(mine.getGroupId());
            if (group == null) {
                throw new BizException("队伍数据异常，请刷新重试");
            }
            if (!group.getLeaderStudentId().equals(studentId)) {
                throw new BizException("你是队伍成员，组队邀请由队长发起");
            }
        } else {
            group = createGroup(assignmentId, studentId);
            try {
                labGroupMemberMapper.insert(memberOf(group.getId(), assignmentId, studentId));
            } catch (DuplicateKeyException | DeadlockLoserDataAccessException e) {
                // 并发首邀（双击/双端同时发起）：唯一键冲突或死锁牺牲者即竞争失败方
                throw new BizException("你已加入或已发起过组队，请刷新查看");
            }
            created = true;
        }

        // 被邀请人约束：已在任何队伍（含已发起组队的队长）→ 不可被邀请
        if (memberOf(assignmentId, toStudentId) != null) {
            throw new BizException("「" + target.getRealName() + "」已在队伍中或已自行发起组队，无法邀请");
        }
        // 同一对只允许一次邀请（唯一键 uk_lgi_pair 兜底并发重复提交）
        Long dup = labGroupInviteMapper.selectCount(new LambdaQueryWrapper<LabGroupInvite>()
                .eq(LabGroupInvite::getAssignmentId, assignmentId)
                .eq(LabGroupInvite::getFromStudentId, studentId)
                .eq(LabGroupInvite::getToStudentId, toStudentId));
        if (dup != null && dup > 0) {
            throw new BizException("已向「" + target.getRealName() + "」发起过邀请，请等待对方回应");
        }
        int cap = capOf(classStudentCount(as.getClassId()), groupCountOf(as));
        if (countMembers(group.getId()) >= cap) {
            throw new BizException("你的队伍已满（每组上限 " + cap + " 人）");
        }

        LabGroupInvite inv = new LabGroupInvite();
        inv.setAssignmentId(assignmentId);
        inv.setFromStudentId(studentId);
        inv.setToStudentId(toStudentId);
        inv.setStatus("PENDING");
        inv.setCreatedAt(LocalDateTime.now());
        try {
            labGroupInviteMapper.insert(inv);
        } catch (DuplicateKeyException e) {
            throw new BizException("已向「" + target.getRealName() + "」发起过邀请，请等待对方回应");
        }
        notificationService.push(toStudentId, "「" + me.getRealName() + "」邀请你加入实验作业「"
                + as.getTitle() + "」的" + group.getName() + "，请到作业详情页处理邀请", "ASSIGNMENT");

        // 本人首次建组：此前收到的待响应邀请全部失效（已成为队长，不可再加入他人队伍）
        if (created) {
            expirePendingInvitesTo(assignmentId, studentId, null,
                    "「" + me.getRealName() + "」已自行发起组队，你此前发出的组队邀请已失效");
        }
        return myGroup(studentId, assignmentId);
    }

    /**
     * 接受组队邀请：加入邀请方队伍（发起者即队长）。
     * 并发防护：小组行锁串行化满员校验；组员唯一键防同时接受多个邀请；
     * 邀请状态条件更新（仅 PENDING → ACCEPTED）防重复处理；其余待响应邀请置 EXPIRED。
     */
    @Transactional
    public Map<String, Object> acceptInvite(Long studentId, Long assignmentId, Long inviteId) {
        Assignment as = selfTeamAssignment(assignmentId);
        User me = requireStudentOfClass(studentId, as);
        LabGroupInvite inv = labGroupInviteMapper.selectById(inviteId);
        if (inv == null || !inv.getAssignmentId().equals(assignmentId)) {
            throw new BizException("邀请不存在");
        }
        if (!inv.getToStudentId().equals(studentId)) {
            throw new BizException("无权处理该邀请");
        }
        if (!"PENDING".equals(inv.getStatus())) {
            throw new BizException("该邀请已处理（" + statusText(inv.getStatus()) + "），请刷新查看");
        }
        if (memberOf(assignmentId, studentId) != null) {
            throw new BizException("你已在队伍中，不能接受其他邀请");
        }
        // 行锁读取邀请方队伍：串行化同队入组，防止并发接受导致超员
        LabGroup group = labGroupMapper.selectOne(new LambdaQueryWrapper<LabGroup>()
                .eq(LabGroup::getAssignmentId, assignmentId)
                .eq(LabGroup::getLeaderStudentId, inv.getFromStudentId()));
        if (group == null) {
            throw new BizException("对方队伍已不存在，请刷新");
        }
        group = labGroupMapper.selectByIdForUpdate(group.getId());
        int cap = capOf(classStudentCount(as.getClassId()), groupCountOf(as));
        if (countMembers(group.getId()) >= cap) {
            throw new BizException("对方队伍已满（每组上限 " + cap + " 人），无法加入");
        }
        // 条件更新：仅 PENDING 可流转为 ACCEPTED（并发双击/双端同时处理时后者失败）
        int updated = labGroupInviteMapper.update(null, new LambdaUpdateWrapper<LabGroupInvite>()
                .eq(LabGroupInvite::getId, inviteId)
                .eq(LabGroupInvite::getStatus, "PENDING")
                .set(LabGroupInvite::getStatus, "ACCEPTED")
                .set(LabGroupInvite::getUpdatedAt, LocalDateTime.now()));
        if (updated == 0) {
            throw new BizException("该邀请已被处理，请刷新查看");
        }
        try {
            labGroupMemberMapper.insert(memberOf(group.getId(), assignmentId, studentId));
        } catch (DuplicateKeyException | DeadlockLoserDataAccessException e) {
            // 并发接受同一学生的多个邀请：唯一键冲突 / 死锁牺牲者即竞争失败方（另一邀请已入组）
            throw new BizException("你已加入队伍，请勿重复操作");
        }
        notificationService.push(inv.getFromStudentId(), "「" + me.getRealName() + "」已接受你的组队邀请，加入"
                + group.getName() + "（作业「" + as.getTitle() + "」）", "ASSIGNMENT");
        // 接受即失去被邀请资格：其余待响应邀请全部失效并通知发起者
        expirePendingInvitesTo(assignmentId, studentId, inviteId,
                "「" + me.getRealName() + "」已加入其他队伍，你此前发出的组队邀请已失效");
        return myGroup(studentId, assignmentId);
    }

    /** 拒绝组队邀请：保持被邀请资格（仍可接受其他邀请 / 被其他人邀请） */
    @Transactional
    public Map<String, Object> rejectInvite(Long studentId, Long assignmentId, Long inviteId) {
        Assignment as = selfTeamAssignment(assignmentId);
        User me = requireStudentOfClass(studentId, as);
        LabGroupInvite inv = labGroupInviteMapper.selectById(inviteId);
        if (inv == null || !inv.getAssignmentId().equals(assignmentId)) {
            throw new BizException("邀请不存在");
        }
        if (!inv.getToStudentId().equals(studentId)) {
            throw new BizException("无权处理该邀请");
        }
        if (!"PENDING".equals(inv.getStatus())) {
            throw new BizException("该邀请已处理（" + statusText(inv.getStatus()) + "），请刷新查看");
        }
        int updated = labGroupInviteMapper.update(null, new LambdaUpdateWrapper<LabGroupInvite>()
                .eq(LabGroupInvite::getId, inviteId)
                .eq(LabGroupInvite::getStatus, "PENDING")
                .set(LabGroupInvite::getStatus, "REJECTED")
                .set(LabGroupInvite::getUpdatedAt, LocalDateTime.now()));
        if (updated == 0) {
            throw new BizException("该邀请已被处理，请刷新查看");
        }
        notificationService.push(inv.getFromStudentId(), "「" + me.getRealName()
                + "」婉拒了你的组队邀请（作业「" + as.getTitle() + "」）", "ASSIGNMENT");
        return myGroup(studentId, assignmentId);
    }

    /* ==================== 内部工具 ==================== */

    private Assignment labAssignment(Long assignmentId) {
        Assignment as = assignmentMapper.selectById(assignmentId);
        if (as == null || !"LAB".equals(as.getScoreMode())) {
            throw new BizException("作业不存在或不支持分组实验");
        }
        return as;
    }

    /** 自行组队作业：LAB + 分组开启 + SELF 模式 + 发布中 + 未过截止（allowLate 例外） */
    private Assignment selfTeamAssignment(Long assignmentId) {
        Assignment as = labAssignment(assignmentId);
        Map<String, Object> cfg = requireGroupConfig(as);
        if (!"SELF".equals(cfg.get("mode"))) {
            throw new BizException("该作业为随机分组模式，无需学生组队");
        }
        if ("DRAFT".equals(as.getStatus())) {
            throw new BizException("作业未发布，无法组队");
        }
        if ("CLOSED".equals(as.getStatus())) {
            throw new BizException("作业已关闭，无法组队");
        }
        boolean overdue = as.getDueAt() != null && LocalDateTime.now().isAfter(as.getDueAt());
        if (overdue && (as.getAllowLate() == null || as.getAllowLate() != 1)) {
            throw new BizException("作业已截止，无法组队");
        }
        return as;
    }

    private Map<String, Object> requireGroupConfig(Assignment as) {
        Map<String, Object> cfg = parseGroupConfig(as.getDescription());
        if (cfg == null) {
            throw new BizException("该作业未开启分组实验");
        }
        return cfg;
    }

    private int groupCountOf(Assignment as) {
        Map<String, Object> cfg = parseGroupConfig(as.getDescription());
        return cfg != null ? ((Number) cfg.get("count")).intValue() : 1;
    }

    private User requireStudentOfClass(Long studentId, Assignment as) {
        User me = userMapper.selectById(studentId);
        if (me == null) {
            throw new BizException("账号不存在");
        }
        if (me.getClassId() == null || !me.getClassId().equals(as.getClassId())) {
            throw new BizException("你不在此作业所在班级");
        }
        return me;
    }

    private LabGroupMember memberOf(Long assignmentId, Long studentId) {
        return labGroupMemberMapper.selectOne(new LambdaQueryWrapper<LabGroupMember>()
                .eq(LabGroupMember::getAssignmentId, assignmentId)
                .eq(LabGroupMember::getStudentId, studentId));
    }

    private int countMembers(Long groupId) {
        Long n = labGroupMemberMapper.selectCount(new LambdaQueryWrapper<LabGroupMember>()
                .eq(LabGroupMember::getGroupId, groupId));
        return n == null ? 0 : n.intValue();
    }

    private int classStudentCount(Long classId) {
        Long n = userMapper.selectCount(new LambdaQueryWrapper<User>()
                .eq(User::getClassId, classId).eq(User::getRole, "STUDENT"));
        return n == null ? 0 : n.intValue();
    }

    /** 每组人数上限：⌈班级人数 ÷ 分组数量⌉（自行组队模式的满员约束） */
    private int capOf(int classSize, int groupCount) {
        if (groupCount < 1) {
            groupCount = 1;
        }
        return Math.max(1, (classSize + groupCount - 1) / groupCount);
    }

    private LabGroupMember memberOf(Long groupId, Long assignmentId, Long studentId) {
        LabGroupMember gm = new LabGroupMember();
        gm.setGroupId(groupId);
        gm.setAssignmentId(assignmentId);
        gm.setStudentId(studentId);
        gm.setCreatedAt(LocalDateTime.now());
        return gm;
    }

    /** 建组（自行组队）：锁定读取当前最大序号 + 唯一键兜底，并发建组不撞号 */
    private LabGroup createGroup(Long assignmentId, Long leaderId) {
        for (int i = 0; i < 6; i++) {
            LabGroup last = labGroupMapper.selectLastByAssignmentForUpdate(assignmentId);
            int seq = (last == null ? 0 : last.getSeq()) + 1;
            LabGroup grp = new LabGroup();
            grp.setAssignmentId(assignmentId);
            grp.setSeq(seq);
            grp.setName("第" + seq + "组");
            grp.setLeaderStudentId(leaderId);
            grp.setCreatedAt(LocalDateTime.now());
            try {
                labGroupMapper.insert(grp);
                return grp;
            } catch (DuplicateKeyException e) {
                // 并发建组撞序号：重取最新序号重试（锁定读能看到已提交的新行）
            }
        }
        throw new BizException("创建队伍失败，请稍后重试");
    }

    /** 将某学生收到的其余待响应邀请置为 EXPIRED，并逐个通知发起者（排除 excludeId） */
    private void expirePendingInvitesTo(Long assignmentId, Long studentId, Long excludeId, String notifyContent) {
        List<LabGroupInvite> pending = labGroupInviteMapper.selectList(
                new LambdaQueryWrapper<LabGroupInvite>()
                        .eq(LabGroupInvite::getAssignmentId, assignmentId)
                        .eq(LabGroupInvite::getToStudentId, studentId)
                        .eq(LabGroupInvite::getStatus, "PENDING"));
        for (LabGroupInvite inv : pending) {
            if (excludeId != null && inv.getId().equals(excludeId)) {
                continue;
            }
            labGroupInviteMapper.update(null, new LambdaUpdateWrapper<LabGroupInvite>()
                    .eq(LabGroupInvite::getId, inv.getId())
                    .eq(LabGroupInvite::getStatus, "PENDING")
                    .set(LabGroupInvite::getStatus, "EXPIRED")
                    .set(LabGroupInvite::getUpdatedAt, LocalDateTime.now()));
            notificationService.push(inv.getFromStudentId(), notifyContent, "ASSIGNMENT");
        }
    }

    /** 小组 DTO：id/名称/成员列表（组长置首并标注 leader） */
    private Map<String, Object> groupDto(LabGroup grp, List<LabGroupMember> members, Map<Long, User> uMap) {
        List<LabGroupMember> sorted = members.stream()
                .sorted(Comparator.comparing((LabGroupMember m) -> !grp.getLeaderStudentId().equals(m.getStudentId())))
                .collect(Collectors.toList());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", String.valueOf(grp.getId()));
        m.put("name", grp.getName());
        m.put("leaderId", String.valueOf(grp.getLeaderStudentId()));
        m.put("count", sorted.size());
        m.put("members", sorted.stream().map(mem -> {
            User u = uMap.get(mem.getStudentId());
            Map<String, Object> mm = new LinkedHashMap<>();
            mm.put("id", String.valueOf(mem.getStudentId()));
            mm.put("name", u != null ? u.getRealName() : "已离班学生");
            mm.put("leader", grp.getLeaderStudentId().equals(mem.getStudentId()));
            return mm;
        }).collect(Collectors.toList()));
        return m;
    }

    private String statusText(String status) {
        return switch (status == null ? "" : status) {
            case "ACCEPTED" -> "已接受";
            case "REJECTED" -> "已拒绝";
            case "EXPIRED" -> "已失效";
            default -> "已处理";
        };
    }
}
